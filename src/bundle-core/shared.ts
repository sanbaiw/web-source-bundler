import { mkdirSync } from "node:fs";
import path from "node:path";

import type { FetchedSource, TextSourceClassification } from "./types";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function stripTags(text: string): string {
  return decodeHtml(
    text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function firstLine(text: string): string {
  return (
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) || ""
  );
}

export function sanitizeBaseName(value: string, fallback = "page"): string {
  const normalized = decodeHtml(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();

  return normalized || fallback;
}

export function truncateBaseName(value: string, maxLength = 80): string {
  if (value.length <= maxLength) {
    return value;
  }

  return (
    value.slice(0, maxLength).replace(/-+$/g, "") || value.slice(0, maxLength)
  );
}

export function normalizeUrl(
  baseUrl: string,
  href: string | null | undefined,
): string | null {
  if (!href) {
    return null;
  }

  const trimmed = decodeHtml(href.trim());
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:")
  ) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export function documentUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function relativePosix(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(toPosix(fromFile));
  const relativePath = path.posix.relative(fromDir, toPosix(toFile));
  return relativePath || ".";
}

export function absoluteUrlForAsset(
  rawUrl: string,
  baseUrl: string,
): string | null {
  const normalized = normalizeUrl(baseUrl, rawUrl);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === "/_next/image" && parsed.searchParams.has("url")) {
      return normalizeUrl(baseUrl, parsed.searchParams.get("url"));
    }
  } catch {
    return normalized;
  }

  return normalized;
}

export function contentTypeBase(contentType: string): string {
  return ((contentType || "").split(";")[0] ?? "").trim().toLowerCase();
}

export function sourceExtensionFromUrl(sourceUrl: string): string | null {
  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    return extension && extension.length <= 12 ? extension : null;
  } catch {
    return null;
  }
}

export function fallbackTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const name = path.basename(parsed.pathname) || parsed.hostname;
    return name.replace(/[-_]+/g, " ");
  } catch {
    return url;
  }
}

function titleFromMarkdown(body: string): string | null {
  const heading = body.match(/^#\s+(.+?)\s*$/m);
  return heading?.[1] ? heading[1].trim() : null;
}

export function titleFromTextSource(
  source: FetchedSource,
  classification: TextSourceClassification,
  body: string,
): string {
  if (classification.subtype === "markdown") {
    return titleFromMarkdown(body) || fallbackTitleFromUrl(source.finalUrl);
  }

  return fallbackTitleFromUrl(source.finalUrl);
}
