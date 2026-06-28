import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { shouldExcludeImage } from "./page-extraction";
import { DEFAULT_HEADERS, extensionFromContentType } from "./preserved-source";
import {
  absoluteUrlForAsset,
  decodeHtml,
  ensureDir,
  relativePosix,
  sanitizeBaseName,
  truncateBaseName,
} from "./shared";
import type { HtmlBundlePage, PageAssetOutcome } from "./types";

const BINARY_TIMEOUT_MS = 20000;
const MIN_ASSET_BYTES = 512;
const MIN_ASSET_DIMENSION = 24;
const MAX_TINY_ASSET_DIMENSION = 64;

function pageAssetDir(relativeMarkdownPath: string): string {
  const dir = path.posix.dirname(relativeMarkdownPath);
  const base = path.posix.basename(relativeMarkdownPath, ".md");

  if (base === "index") {
    return path.posix.join(dir, "assets");
  }

  return path.posix.join(dir, "assets", base);
}

function extensionFromUrl(assetUrl: string): string {
  try {
    const parsed = new URL(assetUrl);
    const extension = path.extname(parsed.pathname).toLowerCase();
    if (extension && extension.length <= 6) {
      return extension;
    }
  } catch {
    return ".bin";
  }

  return ".bin";
}

function recognizeImageFormat(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 12) {
    return null;
  }
  const head = buffer.subarray(0, 16);
  if (
    head
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "jpeg";
  }
  const ascii6 = head.subarray(0, 6).toString("ascii");
  if (ascii6 === "GIF87a" || ascii6 === "GIF89a") {
    return "gif";
  }
  if (
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (head.subarray(4, 8).toString("ascii") === "ftyp") {
    return "heif";
  }
  const textHead = buffer
    .subarray(0, 256)
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (
    textHead.startsWith("<svg") ||
    (textHead.startsWith("<?xml") && textHead.includes("<svg"))
  ) {
    return "svg";
  }
  return null;
}

async function imagePixelDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata?.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch {
    return null;
  }
  return null;
}

function isTinyDimension({
  width,
  height,
}: { width: number; height: number }): boolean {
  const min = Math.min(width, height);
  const max = Math.max(width, height);
  return min < MIN_ASSET_DIMENSION || max <= MAX_TINY_ASSET_DIMENSION;
}

async function convertSvgToPng(
  buffer: Buffer,
): Promise<{ buffer: Buffer; converted: boolean }> {
  try {
    return {
      buffer: await sharp(buffer).png().toBuffer(),
      converted: true,
    };
  } catch (error) {
    const conversionError =
      error instanceof Error ? error : new Error(String(error));
    console.error(
      `  SVG to PNG conversion failed: ${conversionError.message}, keeping .svg`,
    );
    return { buffer, converted: false };
  }
}

async function downloadBinary(url: string): Promise<{
  buffer: Buffer | null;
  contentType: string | null;
  failReason: string | null;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(BINARY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type"),
      failReason: null,
    };
  } catch (error) {
    const fetchError =
      error instanceof Error ? error : new Error(String(error));
    const curl = spawnSync(
      "curl",
      [
        "-sS",
        "-L",
        "--compressed",
        "--max-time",
        "20",
        "-A",
        DEFAULT_HEADERS["User-Agent"],
        "--output",
        "-",
        url,
      ],
      { encoding: null, maxBuffer: 30 * 1024 * 1024 },
    );

    if (curl.status === 0 && curl.stdout) {
      return {
        buffer: curl.stdout,
        contentType: null,
        failReason: null,
      };
    }

    return {
      buffer: null,
      contentType: null,
      failReason: fetchError.message,
    };
  }
}

export async function downloadImagesForPage(
  page: HtmlBundlePage,
  outputDir: string,
  { svg2png = true }: { svg2png?: boolean } = {},
): Promise<Map<string, PageAssetOutcome>> {
  const byUrl = new Map<string, PageAssetOutcome>();
  const targetDir = pageAssetDir(page.relativePath);
  const absoluteTargetDir = path.join(outputDir, targetDir);
  ensureDir(absoluteTargetDir);

  let index = 1;
  for (const image of page.images) {
    if (byUrl.has(image.url)) {
      continue;
    }

    const fetched = await downloadBinary(image.url);
    if (!fetched.buffer) {
      byUrl.set(image.url, {
        kind: "failed",
        sourceUrl: image.url,
        failReason: fetched.failReason || "Failed to download asset",
      });
      continue;
    }

    const format = recognizeImageFormat(fetched.buffer);
    if (!format) {
      byUrl.set(image.url, {
        kind: "dropped",
        sourceUrl: image.url,
        reason: "not_image",
      });
      continue;
    }

    if (fetched.buffer.length < MIN_ASSET_BYTES) {
      byUrl.set(image.url, {
        kind: "dropped",
        sourceUrl: image.url,
        reason: "too_small_bytes",
      });
      continue;
    }

    const dimensions = await imagePixelDimensions(fetched.buffer);
    if (dimensions && isTinyDimension(dimensions)) {
      byUrl.set(image.url, {
        kind: "dropped",
        sourceUrl: image.url,
        reason: "tiny_dimensions",
      });
      continue;
    }

    const urlName = (() => {
      try {
        return path.basename(
          new URL(image.url).pathname,
          path.extname(new URL(image.url).pathname),
        );
      } catch {
        return "image";
      }
    })();

    let extension =
      extensionFromContentType(fetched.contentType || "") ||
      extensionFromUrl(image.url);
    let imageBuffer = fetched.buffer;

    const isSvg =
      extension === ".svg" ||
      format === "svg" ||
      (fetched.contentType || "").includes("svg");
    if (isSvg && svg2png) {
      const result = await convertSvgToPng(imageBuffer);
      imageBuffer = result.buffer;
      if (result.converted) {
        extension = ".png";
      }
    }

    const baseName = truncateBaseName(
      sanitizeBaseName(
        image.alt || urlName,
        `image-${String(index).padStart(2, "0")}`,
      ),
      80,
    );
    const fileName = `${String(index).padStart(2, "0")}-${baseName}${extension}`;
    const relativeAssetPath = path.posix.join(targetDir, fileName);
    const absoluteAssetPath = path.join(outputDir, relativeAssetPath);

    writeFileSync(absoluteAssetPath, imageBuffer);
    byUrl.set(image.url, {
      kind: "localized",
      sourceUrl: image.url,
      relativePath: relativePosix(page.relativePath, relativeAssetPath),
    });
    index += 1;
  }

  return byUrl;
}

export function replaceImagesWithLocalPaths(
  html: string,
  pageUrl: string,
  imageOutcomes: Map<string, PageAssetOutcome>,
): string {
  return html.replace(
    /(<img\b[^>]*src=")([^"]+)("[^>]*>)/gi,
    (full, start, src, end) => {
      const absolute = absoluteUrlForAsset(src, pageUrl);
      if (!absolute) {
        return full;
      }

      const altMatch = full.match(/\balt="([^"]*)"/i);
      const alt = altMatch?.[1] ? decodeHtml(altMatch[1]) : "";
      if (shouldExcludeImage(absolute, alt)) {
        return "";
      }

      const outcome = imageOutcomes.get(absolute);
      if (!outcome || outcome.kind === "failed") {
        return `${start}${absolute}${end}`;
      }
      if (outcome.kind === "dropped") {
        return "";
      }
      return `${start}${outcome.relativePath}${end}`;
    },
  );
}
