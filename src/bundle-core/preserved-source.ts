import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  contentTypeBase,
  ensureDir,
  firstLine,
  sourceExtensionFromUrl,
} from "./shared";
import type {
  AssetSourceClassification,
  FetchedSource,
  HtmlSourceClassification,
  SourceClassification,
  TextSourceClassification,
} from "./types";

export const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/markdown, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
} as const;

const SOURCE_TIMEOUT_MS = 30000;

function validateSourceUrl(inputUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid source URL: ${inputUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      "Invalid source URL: username and password are not allowed",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid source URL: protocol must be http or https");
  }

  if (!parsed.hostname.includes(".")) {
    throw new Error("Invalid source URL: hostname must contain a dot");
  }

  return parsed;
}

function upgradeInitialUrl(parsedUrl: URL): URL {
  const upgraded = new URL(parsedUrl.toString());
  if (upgraded.protocol === "http:") {
    upgraded.protocol = "https:";
  }
  return upgraded;
}

function removePartialFile(filePath: string): void {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

async function writeFetchBody(
  response: Response,
  destinationPath: string,
): Promise<void> {
  ensureDir(path.dirname(destinationPath));
  removePartialFile(destinationPath);

  if (!response.body) {
    writeFileSync(destinationPath, Buffer.alloc(0));
    return;
  }

  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destinationPath),
  );
}

function curlFetchSource(
  fetchedUrl: string,
  destinationPath: string,
  fetchError: Error,
): {
  finalUrl: string;
  status: number | null;
  contentType: string;
  fetchMethod: "curl-fallback" | "failed";
  failReason: string | null;
} {
  const marker = "__WEB_SOURCE_BUNDLER_CURL_META__";
  ensureDir(path.dirname(destinationPath));
  removePartialFile(destinationPath);
  const curl = spawnSync(
    "curl",
    [
      "-sS",
      "-L",
      "--compressed",
      "--max-time",
      "30",
      "-A",
      DEFAULT_HEADERS["User-Agent"],
      "-H",
      `Accept: ${DEFAULT_HEADERS.Accept}`,
      "--output",
      destinationPath,
      "--write-out",
      `${marker}%{http_code}\t%{url_effective}\t%{content_type}`,
      fetchedUrl,
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );

  const stdout = curl.stdout || "";
  const markerIndex = stdout.lastIndexOf(marker);
  const meta =
    markerIndex === -1
      ? []
      : stdout
          .slice(markerIndex + marker.length)
          .trim()
          .split("\t");
  const httpStatus = Number(meta[0]);
  const finalUrl = meta[1] || fetchedUrl;
  const contentType = meta[2] || "";

  if (
    curl.status === 0 &&
    httpStatus >= 200 &&
    httpStatus < 400 &&
    existsSync(destinationPath)
  ) {
    return {
      finalUrl,
      status: httpStatus,
      contentType,
      fetchMethod: "curl-fallback",
      failReason: null,
    };
  }

  removePartialFile(destinationPath);
  const curlError = firstLine(curl.stderr || "");
  return {
    finalUrl,
    status: Number.isFinite(httpStatus) ? httpStatus : null,
    contentType,
    fetchMethod: "failed",
    failReason: `${firstLine(fetchError.message)}${curlError ? ` | curl: ${curlError}` : ""}`,
  };
}

export async function fetchSource(
  inputUrl: string,
  destinationPath: string,
): Promise<FetchedSource> {
  const requested = validateSourceUrl(inputUrl);
  const fetched = upgradeInitialUrl(requested);

  try {
    const response = await fetch(fetched, {
      headers: DEFAULT_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    await writeFetchBody(response, destinationPath);

    return {
      requestedUrl: requested.toString(),
      fetchedUrl: fetched.toString(),
      finalUrl: response.url || fetched.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      preservedPath: destinationPath,
      failReason: null,
      fetchMethod: "fetch",
    };
  } catch (error) {
    const fetchError =
      error instanceof Error ? error : new Error(String(error));
    const curlResult = curlFetchSource(
      fetched.toString(),
      destinationPath,
      fetchError,
    );
    if (!curlResult.failReason) {
      return {
        requestedUrl: requested.toString(),
        fetchedUrl: fetched.toString(),
        finalUrl: curlResult.finalUrl,
        status: curlResult.status,
        contentType: curlResult.contentType,
        preservedPath: destinationPath,
        failReason: null,
        fetchMethod: "curl-fallback",
      };
    }

    throw new Error(curlResult.failReason || fetchError.message);
  }
}

function isGenericContentType(baseType: string): boolean {
  return (
    !baseType ||
    baseType === "application/octet-stream" ||
    baseType === "binary/octet-stream"
  );
}

function textClassification(
  subtype: string,
  {
    language = subtype,
    render = "fenced",
    extension = ".txt",
  }: Partial<TextSourceClassification> = {},
): TextSourceClassification {
  return {
    kind: "text",
    subtype,
    language,
    render,
    extension,
  };
}

function htmlClassification(): HtmlSourceClassification {
  return {
    kind: "html",
    subtype: "html",
    language: "html",
    render: "html",
    extension: ".html",
  };
}

function assetClassification(
  subtype: string,
  extension = ".bin",
): AssetSourceClassification {
  return {
    kind: "asset",
    subtype,
    language: "",
    render: "asset",
    extension,
  };
}

function textClassificationFromContentType(
  baseType: string,
): TextSourceClassification | HtmlSourceClassification | null {
  if (baseType === "text/html" || baseType === "application/xhtml+xml") {
    return htmlClassification();
  }

  if (baseType === "text/markdown") {
    return textClassification("markdown", {
      language: "markdown",
      render: "direct",
      extension: ".md",
    });
  }

  if (baseType === "text/plain") {
    return textClassification("plain", {
      language: "",
      render: "direct",
      extension: ".txt",
    });
  }

  if (baseType === "application/json" || baseType.endsWith("+json")) {
    return textClassification("json", { language: "json", extension: ".json" });
  }

  if (
    baseType === "application/xml" ||
    baseType.endsWith("+xml") ||
    baseType === "application/rss+xml" ||
    baseType === "application/atom+xml"
  ) {
    return textClassification("xml", { language: "xml", extension: ".xml" });
  }

  if (baseType === "application/javascript" || baseType === "text/javascript") {
    return textClassification("javascript", {
      language: "javascript",
      extension: ".js",
    });
  }

  if (baseType === "application/x-www-form-urlencoded") {
    return textClassification("form", { language: "text", extension: ".txt" });
  }

  if (baseType === "text/css") {
    return textClassification("css", { language: "css", extension: ".css" });
  }

  if (baseType === "text/csv") {
    return textClassification("csv", { language: "csv", extension: ".csv" });
  }

  if (baseType.startsWith("text/")) {
    return textClassification(baseType.slice("text/".length), {
      language: baseType.slice("text/".length),
      extension: ".txt",
    });
  }

  return null;
}

function sourceAssetExtensionFromContentType(
  contentType: string,
): string | null {
  const baseType = contentTypeBase(contentType);
  switch (baseType) {
    case "application/pdf":
      return ".pdf";
    case "application/zip":
      return ".zip";
    case "application/gzip":
      return ".gz";
    case "application/x-tar":
      return ".tar";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    default:
      return extensionFromContentType(contentType);
  }
}

function sourceClassificationFromExtension(
  extension: string | null,
): SourceClassification | null {
  switch (extension) {
    case ".html":
    case ".htm":
      return htmlClassification();
    case ".md":
    case ".markdown":
      return textClassification("markdown", {
        language: "markdown",
        render: "direct",
        extension: ".md",
      });
    case ".txt":
      return textClassification("plain", {
        language: "",
        render: "direct",
        extension: ".txt",
      });
    case ".json":
      return textClassification("json", {
        language: "json",
        extension: ".json",
      });
    case ".xml":
    case ".rss":
    case ".atom":
      return textClassification("xml", { language: "xml", extension: ".xml" });
    case ".js":
    case ".mjs":
    case ".cjs":
      return textClassification("javascript", {
        language: "javascript",
        extension: ".js",
      });
    case ".css":
      return textClassification("css", { language: "css", extension: ".css" });
    case ".csv":
      return textClassification("csv", { language: "csv", extension: ".csv" });
    case ".yaml":
    case ".yml":
      return textClassification("yaml", {
        language: "yaml",
        extension: ".yaml",
      });
    case ".pdf":
      return assetClassification("application/pdf", ".pdf");
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".avif":
    case ".zip":
    case ".docx":
    case ".pptx":
    case ".xlsx":
      return assetClassification("binary", extension);
    default:
      return null;
  }
}

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint != null &&
        ((codePoint >= 0 && codePoint <= 8) ||
          (codePoint >= 14 && codePoint <= 31))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sourceClassificationFromBytes(buffer: Buffer): SourceClassification {
  const sample = buffer.subarray(0, 4096);

  if (sample.subarray(0, 5).toString("ascii") === "%PDF-") {
    return assetClassification("application/pdf", ".pdf");
  }
  if (
    sample
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return assetClassification("image/png", ".png");
  }
  if (sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return assetClassification("image/jpeg", ".jpg");
  }
  if (
    sample.subarray(0, 6).toString("ascii") === "GIF87a" ||
    sample.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return assetClassification("image/gif", ".gif");
  }
  if (
    sample.subarray(0, 4).toString("ascii") === "RIFF" &&
    sample.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return assetClassification("image/webp", ".webp");
  }
  if (sample.subarray(0, 2).toString("ascii") === "PK") {
    return assetClassification("application/zip", ".zip");
  }

  if (isUtf8Text(sample)) {
    const text = sample.toString("utf8").trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html")) {
      return htmlClassification();
    }
    return textClassification("plain", {
      language: "",
      render: "direct",
      extension: ".txt",
    });
  }

  return assetClassification("binary", ".bin");
}

export function classifySource(source: FetchedSource): SourceClassification {
  const baseType = contentTypeBase(source.contentType);
  if (!isGenericContentType(baseType)) {
    const textClassificationResult =
      textClassificationFromContentType(baseType);
    if (textClassificationResult) {
      return textClassificationResult;
    }

    return assetClassification(
      baseType,
      sourceAssetExtensionFromContentType(source.contentType) ||
        sourceExtensionFromUrl(source.finalUrl) ||
        ".bin",
    );
  }

  const extensionClassification = sourceClassificationFromExtension(
    sourceExtensionFromUrl(source.finalUrl),
  );
  if (extensionClassification) {
    return extensionClassification;
  }

  return sourceClassificationFromBytes(readFileSync(source.preservedPath));
}

export function extensionFromContentType(contentType: string): string | null {
  const baseType = contentTypeBase(contentType);
  switch (baseType) {
    case "application/pdf":
      return ".pdf";
    case "application/zip":
      return ".zip";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return null;
  }
}

export function sourceAssetExtension(
  source: FetchedSource,
  classification: AssetSourceClassification,
): string {
  return (
    classification.extension ||
    sourceAssetExtensionFromContentType(source.contentType) ||
    sourceExtensionFromUrl(source.finalUrl) ||
    ".bin"
  );
}
