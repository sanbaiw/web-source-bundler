#!/usr/bin/env node

import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sharp from "sharp";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/markdown, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const SOURCE_TIMEOUT_MS = 30000;
const BINARY_TIMEOUT_MS = 20000;

// Asset hygiene thresholds. A localized image must clear all of these to be kept;
// the goal is to drop tracking pixels, favicons, share badges, and UI-chrome icons
// while keeping genuine figures. Conservative on the keep side: unknown dimensions
// are never treated as a reason to drop.
const MIN_ASSET_BYTES = 512; // tracking pixels / micro-sprites are tens of bytes
const MIN_ASSET_DIMENSION = 24; // smaller side this tiny => rule/badge/pixel (e.g. 109x20 shield)
const MAX_TINY_ASSET_DIMENSION = 64; // larger side this small => favicon/avatar/sprite (e.g. 48x48)

function usage(exitCode = 1) {
  console.error(`Usage:
  web-source-bundler --bundle [options] <url> <output-dir>

Options:
  --no-svg2png   Keep SVG images as-is instead of converting to PNG (default: convert)

Bundle mode fetches and preserves a source URL, writes a readable Markdown
entry, downloads each direct reference into the references directory, downloads
page images, rewrites local cross-links, and writes references/references.json.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("-h") || args.includes("--help")) {
    usage(0);
  }

  const bundleIndex = args.indexOf("--bundle");
  if (bundleIndex === -1) {
    usage();
  }

  const svg2png = !args.includes("--no-svg2png");
  const positional = args.filter((a) => a !== "--bundle" && a !== "--no-svg2png");
  if (positional.length !== 2) {
    usage();
  }

  return {
    mode: "bundle",
    url: positional[0],
    outDir: positional[1],
    svg2png,
  };
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripTags(text) {
  return decodeHtml(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function firstLine(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) || "";
}

function sanitizeBaseName(value, fallback = "page") {
  const normalized = decodeHtml(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();

  return normalized || fallback;
}

function truncateBaseName(value, maxLength = 80) {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).replace(/-+$/g, "") || value.slice(0, maxLength);
}

function normalizeUrl(baseUrl, href) {
  if (!href) {
    return null;
  }

  const trimmed = decodeHtml(href.trim());
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:") || trimmed.startsWith("mailto:")) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function relativePosix(fromFile, toFile) {
  const fromDir = path.posix.dirname(toPosix(fromFile));
  const rel = path.posix.relative(fromDir, toPosix(toFile));
  return rel || ".";
}

function absoluteUrlForAsset(rawUrl, baseUrl) {
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

function validateSourceUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid source URL: ${inputUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("Invalid source URL: username and password are not allowed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid source URL: protocol must be http or https");
  }

  if (!parsed.hostname.includes(".")) {
    throw new Error("Invalid source URL: hostname must contain a dot");
  }

  return parsed;
}

function upgradeInitialUrl(parsedUrl) {
  const upgraded = new URL(parsedUrl.toString());
  if (upgraded.protocol === "http:") {
    upgraded.protocol = "https:";
  }
  return upgraded;
}

function removePartialFile(filePath) {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

async function writeFetchBody(response, destinationPath) {
  ensureDir(path.dirname(destinationPath));
  removePartialFile(destinationPath);

  if (!response.body) {
    writeFileSync(destinationPath, Buffer.alloc(0));
    return;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

function curlFetchSource(fetchedUrl, destinationPath, fetchError) {
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
  const meta = markerIndex === -1 ? [] : stdout.slice(markerIndex + marker.length).trim().split("\t");
  const httpStatus = Number(meta[0]);
  const finalUrl = meta[1] || fetchedUrl;
  const contentType = meta[2] || "";

  if (curl.status === 0 && httpStatus >= 200 && httpStatus < 400 && existsSync(destinationPath)) {
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

async function fetchSource(inputUrl, destinationPath) {
  const requested = validateSourceUrl(inputUrl);
  const fetched = upgradeInitialUrl(requested);

  try {
    const res = await fetch(fetched, {
      headers: DEFAULT_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    await writeFetchBody(res, destinationPath);

    return {
      requestedUrl: requested.toString(),
      fetchedUrl: fetched.toString(),
      finalUrl: res.url || fetched.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      preservedPath: destinationPath,
      failReason: null,
      fetchMethod: "fetch",
    };
  } catch (error) {
    const curlResult = curlFetchSource(fetched.toString(), destinationPath, error);
    if (!curlResult.failReason) {
      return {
        requestedUrl: requested.toString(),
        fetchedUrl: fetched.toString(),
        finalUrl: curlResult.finalUrl,
        status: curlResult.status,
        contentType: curlResult.contentType,
        preservedPath: destinationPath,
        failReason: null,
        fetchMethod: curlResult.fetchMethod,
      };
    }

    throw new Error(curlResult.failReason || error.message);
  }
}

function contentTypeBase(contentType) {
  return (contentType || "").split(";")[0].trim().toLowerCase();
}

function isGenericContentType(baseType) {
  return !baseType || baseType === "application/octet-stream" || baseType === "binary/octet-stream";
}

function sourceExtensionFromUrl(sourceUrl) {
  try {
    const ext = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    return ext && ext.length <= 12 ? ext : null;
  } catch {
    return null;
  }
}

function textClassification(subtype, { language = subtype, render = "fenced", extension = ".txt" } = {}) {
  return {
    kind: "text",
    subtype,
    language,
    render,
    extension,
  };
}

function htmlClassification() {
  return {
    kind: "html",
    subtype: "html",
    language: "html",
    render: "html",
    extension: ".html",
  };
}

function assetClassification(subtype, extension = ".bin") {
  return {
    kind: "asset",
    subtype,
    language: "",
    render: "asset",
    extension,
  };
}

function textClassificationFromContentType(baseType) {
  if (baseType === "text/html" || baseType === "application/xhtml+xml") {
    return htmlClassification();
  }

  if (baseType === "text/markdown") {
    return textClassification("markdown", { language: "markdown", render: "direct", extension: ".md" });
  }

  if (baseType === "text/plain") {
    return textClassification("plain", { language: "", render: "direct", extension: ".txt" });
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
    return textClassification("javascript", { language: "javascript", extension: ".js" });
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

function sourceAssetExtensionFromContentType(contentType) {
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

function sourceClassificationFromExtension(ext) {
  switch (ext) {
    case ".html":
    case ".htm":
      return htmlClassification();
    case ".md":
    case ".markdown":
      return textClassification("markdown", { language: "markdown", render: "direct", extension: ".md" });
    case ".txt":
      return textClassification("plain", { language: "", render: "direct", extension: ".txt" });
    case ".json":
      return textClassification("json", { language: "json", extension: ".json" });
    case ".xml":
    case ".rss":
    case ".atom":
      return textClassification("xml", { language: "xml", extension: ".xml" });
    case ".js":
    case ".mjs":
    case ".cjs":
      return textClassification("javascript", { language: "javascript", extension: ".js" });
    case ".css":
      return textClassification("css", { language: "css", extension: ".css" });
    case ".csv":
      return textClassification("csv", { language: "csv", extension: ".csv" });
    case ".yaml":
    case ".yml":
      return textClassification("yaml", { language: "yaml", extension: ".yaml" });
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
      return assetClassification("binary", ext);
    default:
      return null;
  }
}

function isUtf8Text(buffer) {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return !/[\u0000-\u0008\u000E-\u001F]/.test(text);
  } catch {
    return false;
  }
}

function sourceClassificationFromBytes(buffer) {
  const sample = buffer.subarray(0, 4096);

  if (sample.subarray(0, 5).toString("ascii") === "%PDF-") {
    return assetClassification("application/pdf", ".pdf");
  }
  if (sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return assetClassification("image/png", ".png");
  }
  if (sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return assetClassification("image/jpeg", ".jpg");
  }
  if (sample.subarray(0, 6).toString("ascii") === "GIF87a" || sample.subarray(0, 6).toString("ascii") === "GIF89a") {
    return assetClassification("image/gif", ".gif");
  }
  if (sample.subarray(0, 4).toString("ascii") === "RIFF" && sample.subarray(8, 12).toString("ascii") === "WEBP") {
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
    return textClassification("plain", { language: "", render: "direct", extension: ".txt" });
  }

  return assetClassification("binary", ".bin");
}

function classifySource(source) {
  const baseType = contentTypeBase(source.contentType);
  if (!isGenericContentType(baseType)) {
    const textClassificationResult = textClassificationFromContentType(baseType);
    if (textClassificationResult) {
      return textClassificationResult;
    }

    return assetClassification(baseType, sourceAssetExtensionFromContentType(source.contentType) || sourceExtensionFromUrl(source.finalUrl) || ".bin");
  }

  const extClassification = sourceClassificationFromExtension(sourceExtensionFromUrl(source.finalUrl));
  if (extClassification) {
    return extClassification;
  }

  return sourceClassificationFromBytes(readFileSync(source.preservedPath));
}

function extractMain(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) {
    return main[1];
  }

  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function extractArticle(html) {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return article ? article[1] : html;
}

function extractTitle(html) {
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (ogTitle && stripTags(ogTitle[1])) {
    return stripTags(ogTitle[1]);
  }

  const metaTitle = html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i);
  if (metaTitle && stripTags(metaTitle[1])) {
    return stripTags(metaTitle[1]);
  }

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    return stripTags(h1[1]);
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) {
    return "Untitled";
  }

  return stripTags(title[1])
    .replace(/\s*[|\\-]\\s*anthropic$/i, "")
    .replace(/\s*[|\\-]\\s*wikipedia$/i, "")
    .trim();
}

function cleanHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/\sclass="[^"]*"/gi, "")
    .replace(/\sstyle="[^"]*"/gi, "");
}

// Remove an element (and its subtree) by matching an opening tag whose attributes
// satisfy `attrTest`, then walking forward with tag-depth counting to find the
// matching close. Regex alone cannot balance nested same-name tags; this small
// scanner does, with no new dependency. Used for role-based chrome and the GitHub
// README isolation where naive `.*?` would cut at the first inner close tag.
function removeBalancedTag(html, tagName, attrTest) {
  const open = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const tagPair = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  let result = html;
  let guard = 0;
  while (guard < 1000) {
    guard += 1;
    open.lastIndex = 0;
    let match = null;
    for (let m = open.exec(result); m; m = open.exec(result)) {
      if (attrTest(m[1] || "")) {
        match = m;
        break;
      }
    }
    if (!match) {
      return result;
    }

    const start = match.index;
    tagPair.lastIndex = start;
    let depth = 0;
    let end = -1;
    for (let t = tagPair.exec(result); t; t = tagPair.exec(result)) {
      depth += t[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    if (end === -1) {
      return result; // unbalanced; leave as-is rather than truncate
    }
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

function attrValue(attrs, attr) {
  const quoted = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  if (quoted) {
    return quoted[2];
  }
  const bare = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*([^\\s>]+)`, "i"));
  return bare ? bare[1] : null;
}

function attrHasRole(attrs, ...roles) {
  const value = attrValue(attrs, "role");
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return roles.some((role) => normalized.split(/\s+/).includes(role));
}

function attrMatches(attrs, attr, re) {
  const value = attrValue(attrs, attr);
  if (!value) {
    return false;
  }
  return re.test(value);
}

// Generic, zero-config structural chrome removal applied to every HTML page.
function stripGenericChrome(html) {
  let cleaned = html;
  for (const tagName of ["nav", "header", "footer", "aside"]) {
    cleaned = removeBalancedTag(cleaned, tagName, () => true);
  }
  cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
    attrHasRole(attrs, "navigation", "complementary", "banner", "contentinfo", "search"),
  );
  cleaned = removeBalancedTag(cleaned, "section", (attrs) =>
    attrHasRole(attrs, "navigation", "complementary"),
  );
  // Wikipedia-style "[edit]" section markers when they survive as plain text.
  cleaned = cleaned.replace(/\[\s*edit\s*\]/gi, "");
  return cleaned;
}

// Site-rule registry: built-in defaults so common sources work with zero config,
// behind an extensible seam. Each rule is { id, test(hostname), clean(html) }.
// To add a site, push another entry; to override, replace one. Rules run in
// parsePage before generic extraction, on the full fetched HTML.
const SITE_RULES = [
  {
    id: "arxiv",
    test: (hostname) => /(^|\.)arxiv\.org$/i.test(hostname),
    clean(html) {
      let cleaned = html;
      // Live arXiv pages prepend a subject H1 and breadcrumb block before the
      // real title/abstract content. Drop that chrome so the generic leading-H1
      // strip removes the paper title, not the subject banner.
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\bsubheader\b/i));
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\bheader-breadcrumbs-mobile\b/i));
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\bbrowse\b/i));
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\bextra-ref-cite\b/i));
      cleaned = cleaned.replace(/<a\b[^>]*class="[^"]*\bmobile-submission-download\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");
      // The abstract is the value; everything from "References & Citations" on is
      // citation-tool / bibliographic / arXivLabs / MathJax-toggle chrome.
      const cut = cleaned.search(/<h3>\s*References\s*&amp;\s*Citations\s*<\/h3>|<h3>\s*References\s*&\s*Citations\s*<\/h3>/i);
      cleaned = cut === -1 ? cleaned : cleaned.slice(0, cut);
      const toolsCut = cleaned.search(/<div\b[^>]*(?:id\s*=\s*['"]bib-cite-modal['"]|class\s*=\s*['"]bookmarks['"]|id\s*=\s*['"]labstabs['"])/i);
      cleaned = toolsCut === -1 ? cleaned : cleaned.slice(0, toolsCut);
      return cleaned;
    },
  },
  {
    id: "wikipedia",
    test: (hostname) => /(^|\.)wikipedia\.org$/i.test(hostname),
    clean(html) {
      let cleaned = html;
      // Live Wikipedia pages wrap article prose in mw-content-text/mw-parser-output.
      // Isolate that inner content so jump links, page chrome, print footer, and
      // category rails never reach Turndown.
      const parserOutput =
        cleaned.match(/<div id="mw-content-text"[^>]*>[\s\S]*?<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*(?:<noscript|<div class="printfooter"|<div id="catlinks")/i)
        || cleaned.match(/<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*(?:<noscript|<div class="printfooter"|<div id="catlinks")/i);
      if (parserOutput) {
        cleaned = parserOutput[1];
      }
      // Citation apparatus, navboxes, edit links, category footer -- all keyed on
      // MediaWiki's stable class/id hooks.
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\breflist\b/i));
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "class", /\bnavbox\b/i));
      cleaned = removeBalancedTag(cleaned, "div", (attrs) => attrMatches(attrs, "id", /\bcatlinks\b/i));
      cleaned = removeBalancedTag(cleaned, "span", (attrs) => attrMatches(attrs, "class", /\bmw-editsection\b/i));
      cleaned = removeBalancedTag(cleaned, "table", (attrs) => attrMatches(attrs, "class", /\bnavbox\b/i));
      cleaned = cleaned.replace(/<div[^>]*class="[^"]*\bshortdescription\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
      cleaned = cleaned.replace(/<div[^>]*class="[^"]*\bmw-subjectpageheader\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
      cleaned = cleaned.replace(/<p\b[^>]*class="[^"]*\bmw-empty-elt\b[^"]*"[^>]*>\s*<\/p>/gi, "");
      cleaned = cleaned.replace(/<meta\b[^>]*property="mw:PageProp\/toc"[^>]*>/gi, "");
      const cut = cleaned.search(/<div\b[^>]*class="[^"]*\bmw-heading\b[^"]*"[^>]*>\s*<h2\b[^>]*id="(?:References|External_links)"/i);
      cleaned = cut === -1 ? cleaned : cleaned.slice(0, cut);
      return cleaned;
    },
  },
  {
    id: "github",
    test: (hostname) => /(^|\.)github\.com$/i.test(hostname),
    clean(html) {
      // Keep the rendered README (article.markdown-body); drop the repo's file
      // tree, language bar, and social chrome that surround it.
      const readme = html.match(/<article\b[^>]*class="[^"]*markdown-body[^"]*"[^>]*>[\s\S]*?<\/article>/i);
      if (readme) {
        return `<main><article>${readme[0]}</article></main>`;
      }
      return html;
    },
  },
  {
    id: "bolt-new",
    test: (hostname) => /(^|\.)(?:bolt|blot)\.new$/i.test(hostname),
    clean(html) {
      let cleaned = html;
      // The public homepage is an app prompt wrapped by a marketing landing page.
      // Keep the hero/prompt shell and drop the sections that trigger off-page
      // support/pricing/social reference crawls.
      cleaned = cleaned.replace(/<h1\b([^>]*)>/i, "<h2$1>").replace(/<\/h1>/i, "</h2>");
      cleaned = removeBalancedTag(cleaned, "button", () => true);
      cleaned = removeBalancedTag(cleaned, "input", () => true);
      cleaned = cleaned.replace(/<p\b[^>]*>\s*or\s+import\s+from\s*<\/p>/gi, "");

      const cutMarkers = [
        /<h2\b[^>]*>\s*Your\s+company(?:'|’|&#x27;|&apos;)?s\s+design\s+system,\s+now\s+in\s+Bolt/i,
        /<h2\b[^>]*>\s*The\s+#?1\s+professional\s+vibe\s+coding\s+tool/i,
        /<h2\b[^>]*>\s*Ready\s+to\s+build\s+something\s+amazing\?/i,
      ];
      const cut = cutMarkers.reduce((first, pattern) => {
        const match = cleaned.match(pattern);
        if (!match) {
          return first;
        }
        return first === -1 ? match.index : Math.min(first, match.index);
      }, -1);

      return cut === -1 ? cleaned : `${cleaned.slice(0, cut)}</body></html>`;
    },
  },
];

function applySiteRules(html, url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return html;
  }
  let cleaned = html;
  for (const rule of SITE_RULES) {
    if (rule.test(hostname)) {
      cleaned = rule.clean(cleaned);
    }
  }
  return cleaned;
}

function stripLeadingBodyH1(html) {
  // We always emit our own `# {title}` provenance header, so the first in-body
  // <h1> is redundant. Some real sites place large chrome blocks before the
  // content H1, so strip the first H1 regardless of its byte offset.
  const match = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/i);
  if (!match) {
    return html;
  }

  return `${html.slice(0, match.index)}${html.slice(match.index + match[0].length)}`.trimStart();
}

function extractLinks(html, baseUrl) {
  const refs = [];
  const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkRe)) {
    const url = normalizeUrl(baseUrl, match[1]);
    if (url) {
      refs.push(url);
    }
  }

  return unique(refs);
}

function extractImages(html, baseUrl) {
  const images = [];
  const imgRe = /<img\b[^>]*src="([^"]+)"[^>]*>/gi;

  for (const match of html.matchAll(imgRe)) {
    const rawTag = match[0];
    const url = absoluteUrlForAsset(match[1], baseUrl);
    if (!url) {
      continue;
    }

    const altMatch = rawTag.match(/\balt="([^"]*)"/i);
    const alt = altMatch ? decodeHtml(altMatch[1]) : "";
    if (shouldExcludeImage(url, alt)) {
      continue;
    }

    const normalizedAlt = sanitizeBaseName(alt, "");
    if (normalizedAlt.startsWith("displaystyle") || url.includes("/math/")) {
      continue;
    }

    images.push({ url, alt });
  }

  return images;
}

function shouldExcludeImage(url, alt = "") {
  const normalizedAlt = sanitizeBaseName(alt, "");
  if (isChromeName(normalizedAlt)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const fileName = sanitizeBaseName(path.basename(parsed.pathname, path.extname(parsed.pathname)), "");
    return isChromeName(fileName);
  } catch {
    return false;
  }
}

// Name-based pre-download filter for obvious UI chrome. Conservative: matches
// only whole-word chrome tokens so it never drops a real figure whose name merely
// contains a substring. The byte/dimension floors in downloadImagesForPage do the
// heavier lifting after download.
const CHROME_NAME_TOKENS = new Set([
  "logo",
  "icon",
  "avatar",
  "pixel",
  "spacer",
  "badge",
]);

function isChromeName(name) {
  if (!name) {
    return false;
  }
  if (name === "logo" || name.endsWith("-logo") || name.includes("-logo-") || name.startsWith("logo-")) {
    return true;
  }
  const tokens = name.split("-");
  return tokens.some((token) => CHROME_NAME_TOKENS.has(token));
}

function parsePage(url, html) {
  // Title comes from the original <head> (og:title/twitter:title live outside the
  // body). Content extraction runs on HTML that has been through the site-rule
  // registry and the generic structural-chrome pass.
  const title = extractTitle(html);
  const deChromed = stripGenericChrome(applySiteRules(html, url));
  const mainHtml = extractMain(deChromed);
  const articleHtml = extractArticle(mainHtml);

  return {
    url,
    title,
    html,
    mainHtml,
    articleHtml,
    directReferences: extractLinks(articleHtml, url),
    allLinks: extractLinks(mainHtml, url),
    images: extractImages(articleHtml, url),
  };
}

function pageAssetDir(relativeMarkdownPath) {
  const dir = path.posix.dirname(relativeMarkdownPath);
  const base = path.posix.basename(relativeMarkdownPath, ".md");

  if (base === "index") {
    return path.posix.join(dir, "assets");
  }

  return path.posix.join(dir, "assets", base);
}

function extensionFromUrl(assetUrl) {
  try {
    const parsed = new URL(assetUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext && ext.length <= 6) {
      return ext;
    }
  } catch {
    return ".bin";
  }

  return ".bin";
}

function extensionFromContentType(contentType) {
  const baseType = (contentType || "").split(";")[0].trim().toLowerCase();
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

// Sentinel stored in a page's image map to mark an asset that was downloaded but
// rejected as junk (tracking pixel, badge, favicon, HTML-error-page-as-image).
// replaceImagesWithLocalPaths removes the embed entirely rather than falling back
// to a remote URL the way it does for genuine fetch failures.
const DROPPED_ASSET = "__web_source_bundler_dropped_asset__";

function recognizeImageFormat(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }
  const head = buffer.subarray(0, 16);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "jpeg";
  }
  const ascii6 = head.subarray(0, 6).toString("ascii");
  if (ascii6 === "GIF87a" || ascii6 === "GIF89a") {
    return "gif";
  }
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  if (head.subarray(4, 8).toString("ascii") === "ftyp") {
    return "heif"; // avif / heic share the ISO-BMFF ftyp box
  }
  // SVG is XML text, recognized after any leading whitespace / xml prolog.
  const textHead = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (textHead.startsWith("<svg") || (textHead.startsWith("<?xml") && textHead.includes("<svg"))) {
    return "svg";
  }
  return null;
}

async function imagePixelDimensions(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (meta && meta.width && meta.height) {
      return { width: meta.width, height: meta.height };
    }
  } catch {
    return null;
  }
  return null;
}

function isTinyDimension({ width, height }) {
  const min = Math.min(width, height);
  const max = Math.max(width, height);
  // Thin bars (shield badges 109x20, license icons 80x15) and 1x1 pixels fail the
  // min-side test; small squares (favicons 16x16, avatars 48x48, feature icons
  // 30x30) fail the max-side test. Genuine figures clear both.
  return min < MIN_ASSET_DIMENSION || max <= MAX_TINY_ASSET_DIMENSION;
}

async function convertSvgToPng(buffer) {
  try {
    return {
      buffer: await sharp(buffer).png().toBuffer(),
      converted: true,
    };
  } catch (error) {
    console.error(`  SVG to PNG conversion failed: ${error.message}, keeping .svg`);
    return { buffer, converted: false };
  }
}

async function downloadBinary(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(BINARY_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
      failReason: null,
    };
  } catch (error) {
    const curl = spawnSync(
      "curl",
      ["-sS", "-L", "--compressed", "--max-time", "20", "-A", DEFAULT_HEADERS["User-Agent"], "--output", "-", url],
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
      failReason: error.message,
    };
  }
}

async function downloadImagesForPage(page, outputDir, { svg2png = true } = {}) {
  const byUrl = new Map();
  const targetDir = pageAssetDir(page.relativePath);
  const absTargetDir = path.join(outputDir, targetDir);
  ensureDir(absTargetDir);

  let index = 1;
  for (const image of page.images) {
    if (byUrl.has(image.url)) {
      continue;
    }

    const fetched = await downloadBinary(image.url);
    if (!fetched.buffer) {
      // Genuine fetch failure: leave unmapped so the embed falls back to the
      // resolved absolute URL (a working remote link) rather than being dropped.
      continue;
    }

    // Reject payloads that are not actually images (e.g. an HTML error page
    // served with an image URL, as Wikimedia does for rate-limited thumbnails).
    const format = recognizeImageFormat(fetched.buffer);
    if (!format) {
      byUrl.set(image.url, DROPPED_ASSET);
      continue;
    }

    // Reject tracking pixels and micro-sprites by byte size.
    if (fetched.buffer.length < MIN_ASSET_BYTES) {
      byUrl.set(image.url, DROPPED_ASSET);
      continue;
    }

    // Reject favicons, avatars, share badges, and UI icons by pixel dimensions.
    // Unknown dimensions (some SVGs) are never a reason to drop.
    const dims = await imagePixelDimensions(fetched.buffer);
    if (dims && isTinyDimension(dims)) {
      byUrl.set(image.url, DROPPED_ASSET);
      continue;
    }

    const urlName = (() => {
      try {
        return path.basename(new URL(image.url).pathname, path.extname(new URL(image.url).pathname));
      } catch {
        return "image";
      }
    })();

    let ext = extensionFromContentType(fetched.contentType) || extensionFromUrl(image.url);
    let imageBuffer = fetched.buffer;

    const isSvg = ext === ".svg" || format === "svg" || (fetched.contentType || "").includes("svg");
    if (isSvg && svg2png) {
      const result = await convertSvgToPng(imageBuffer);
      imageBuffer = result.buffer;
      if (result.converted) {
        ext = ".png";
      }
    }

    const baseName = truncateBaseName(
      sanitizeBaseName(image.alt || urlName, `image-${String(index).padStart(2, "0")}`),
      80,
    );
    const fileName = `${String(index).padStart(2, "0")}-${baseName}${ext}`;
    const relativeAssetPath = path.posix.join(targetDir, fileName);
    const absoluteAssetPath = path.join(outputDir, relativeAssetPath);

    writeFileSync(absoluteAssetPath, imageBuffer);
    byUrl.set(image.url, relativePosix(page.relativePath, relativeAssetPath));
    index += 1;
  }

  return byUrl;
}

function replaceAnchorsWithLocalLinks(html, page, linkMap) {
  return html.replace(/(<a\b[^>]*href=")([^"]+)("[^>]*>)/gi, (full, start, href, end) => {
    const absolute = normalizeUrl(page.url, href);
    if (!absolute) {
      return full;
    }

    const localTarget = linkMap.get(absolute);
    if (!localTarget) {
      if (/^(?:#|mailto:|tel:|javascript:)/i.test(href)) {
        return full;
      }
      return `${start}${absolute}${end}`;
    }

    return `${start}${localTarget}${end}`;
  });
}

function replaceImagesWithLocalPaths(html, page, imageMap) {
  return html.replace(/(<img\b[^>]*src=")([^"]+)("[^>]*>)/gi, (full, start, src, end) => {
    const absolute = absoluteUrlForAsset(src, page.url);
    if (!absolute) {
      return full;
    }

    const altMatch = full.match(/\balt="([^"]*)"/i);
    const alt = altMatch ? decodeHtml(altMatch[1]) : "";
    if (shouldExcludeImage(absolute, alt)) {
      return "";
    }

    const localTarget = imageMap.get(absolute);
    if (localTarget === DROPPED_ASSET) {
      // Asset was downloaded but rejected as junk (pixel/badge/favicon/non-image).
      // Remove the embed entirely.
      return "";
    }
    if (!localTarget) {
      // Image was not localized (download failed or filtered). Leaving the
      // original src risks a dead relative embed like ![](fig1.png); rewrite it
      // to the resolved absolute URL so the embed is at least a working link.
      return `${start}${absolute}${end}`;
    }

    return `${start}${localTarget}${end}`;
  });
}

function buildReferenceSection(page, pageInfoMap, linkMap) {
  if (page.directReferences.length === 0) {
    return [];
  }

  const lines = ["## Direct References", ""];
  for (const ref of page.directReferences) {
    const info = pageInfoMap.get(ref);
    const localTarget = linkMap.get(ref);
    const label = info?.title || ref;
    if (localTarget) {
      lines.push(`- [${label}](${localTarget})`);
    } else {
      lines.push(`- [${label}](${ref})`);
    }
  }

  return lines;
}

function buildProvenanceLines(source) {
  const lines = [`Source: ${source.requestedUrl}`];
  if (source.fetchedUrl !== source.requestedUrl) {
    lines.push(`Fetched URL: ${source.fetchedUrl}`);
  }
  if (source.finalUrl !== source.fetchedUrl) {
    lines.push(`Final URL: ${source.finalUrl}`);
  }
  if (source.contentType) {
    lines.push(`Content-Type: ${source.contentType}`);
  }
  return lines;
}

function renderSourceHeader(title, source) {
  return [`# ${title}`, "", ...buildProvenanceLines(source)];
}

function titleFromMarkdown(body) {
  const heading = body.match(/^#\s+(.+?)\s*$/m);
  return heading ? heading[1].trim() : null;
}

function titleFromTextSource(source, classification, body) {
  if (classification.subtype === "markdown") {
    return titleFromMarkdown(body) || fallbackTitleFromUrl(source.finalUrl);
  }

  return fallbackTitleFromUrl(source.finalUrl);
}

function stripLeadingLlmsTxtPreamble(body) {
  // Mintlify / Claude docs prepend an llms.txt discovery blockquote before the
  // real H1. It is navigation chrome, not content -- drop a leading blockquote
  // block only when it names the documentation index / llms.txt.
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith(">")) {
    return body;
  }

  const lines = trimmed.split("\n");
  let end = 0;
  while (end < lines.length && lines[end].startsWith(">")) {
    end += 1;
  }

  const block = lines.slice(0, end).join("\n");
  if (!/documentation index|llms\.txt/i.test(block)) {
    return body;
  }

  let rest = end;
  while (rest < lines.length && lines[rest].trim() === "") {
    rest += 1;
  }
  return lines.slice(rest).join("\n");
}

function stripLeadingMarkdownH1(body, title) {
  // The provenance header already emits `# {title}`; drop a leading body H1 that
  // repeats it (fuzzy slug compare) so the entry has a single H1.
  const trimmed = body.replace(/^\s+/, "");
  const match = trimmed.match(/^#\s+(.+?)\s*(?:\n|$)/);
  if (!match || sanitizeBaseName(match[1]) !== sanitizeBaseName(title)) {
    return body;
  }
  return trimmed.slice(match[0].length).replace(/^\s+/, "");
}

function closingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function fenceForBody(body) {
  const longestBacktickRun = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longestBacktickRun + 1);
}

// Docs platforms (Mintlify, Docusaurus) serve text/markdown that is really MDX:
// the prose is fine but unrendered JSX component wrappers leak through. Strip the
// common wrappers while keeping their inner content. Generic -- not site-specific.
const MDX_WRAPPER_TAGS = [
  "CodeGroup",
  "CardGroup",
  "Card",
  "Columns",
  "Column",
  "Tabs",
  "Tab",
  "TabItem",
  "Steps",
  "Step",
  "Note",
  "Tip",
  "Warning",
  "Info",
  "Callout",
  "Accordion",
  "AccordionGroup",
  "Frame",
  "Tooltip",
  "ParamField",
  "ResponseField",
  "Expandable",
];

function stripMdxComponents(body) {
  let cleaned = body;
  for (const tag of MDX_WRAPPER_TAGS) {
    // Opening tags (with any attributes, possibly multiline), closing tags, and
    // self-closing tags. Keep inner content for paired tags.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*?/>`, "g"), "");
    cleaned = cleaned.replace(new RegExp(`</?${tag}\\b[^>]*?>`, "g"), "");
  }
  // `<div className="...">` / `</div>` wrappers and a stray `theme={null}` token
  // that Mintlify appends to fenced-code info strings.
  cleaned = cleaned.replace(/<\/?div\b[^>]*>/g, "");
  cleaned = cleaned.replace(/[ \t]+theme=\{null\}/g, "");
  // Collapse blank-line runs left by removals.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

function tidyMarkdownBody(body, title) {
  let cleaned = stripLeadingLlmsTxtPreamble(body);
  cleaned = stripLeadingMarkdownH1(cleaned, title);
  cleaned = stripMdxComponents(cleaned);
  return cleaned;
}

function renderTextSourceEntry(source, classification) {
  const body = readFileSync(source.preservedPath, "utf8");
  const title = titleFromTextSource(source, classification, body);
  const header = renderSourceHeader(title, source);

  if (classification.render === "direct") {
    const rendered = classification.subtype === "markdown" ? tidyMarkdownBody(body, title) : body;
    return `${header.join("\n")}\n\n${closingNewline(rendered)}`;
  }

  const fence = fenceForBody(body);
  const language = classification.language || "text";
  return `${header.join("\n")}\n\n${fence}${language}\n${closingNewline(body)}${fence}\n`;
}

function renderAssetSourceEntry(source, assetPath, markdownPath) {
  const title = fallbackTitleFromUrl(source.finalUrl);
  const localAssetPath = relativePosix(markdownPath, assetPath);
  const header = renderSourceHeader(title, source);

  return `${header.join("\n")}\n\nOriginal source asset: [${localAssetPath}](${localAssetPath})\n\nText extraction is deferred to a specialized pipeline.\n`;
}

function tidyConvertedMarkdown(markdown, selfName = "") {
  // Generic post-conversion cleanup applied to every HTML-derived page.
  // - Drop empty-text links `[](url)` / `[ ](url)` left behind when an anchor's
  //   only child was an icon/<img> that got stripped (edit buttons, social icons).
  let cleaned = markdown.replace(/\[\s*\]\((?:[^)]*)\)/g, (match, offset, source) => {
    return offset > 0 && source[offset - 1] === "!" ? match : "";
  });
  // - Unwrap self-referential links `[text](own-file.md)` to plain text. A page's
  //   own URL localizes to its own basename (cite-as rows, logo links), producing
  //   a link that points back at the file it lives in.
  if (selfName) {
    const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selfLink = new RegExp(`\\[([^\\]]*)\\]\\(\\.?/?${escaped}(?:#[^)]*)?\\)`, "g");
    cleaned = cleaned.replace(selfLink, "$1");
  }
  // Collapse the runs of blank lines that removals can leave behind.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function renderMarkdown(page, pageInfoMap, linkMap, imageMap) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.use(gfm);
  td.remove(["script", "style", "nav", "footer", "header", "noscript", "svg"]);

  // Custom rule: card links (anchors wrapping block-level content like images +
  // headings) get collapsed into clean single-line markdown links instead of the
  // broken multi-line "[  \n\nTitle\n\nCategory\n\n](url)" that Turndown emits.
  const BLOCK_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "DIV", "FIGURE", "PICTURE", "SECTION"]);
  td.addRule("card-link", {
    filter(node) {
      if (node.nodeName !== "A" || !node.getAttribute("href")) {
        return false;
      }
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && (BLOCK_TAGS.has(child.nodeName) || child.nodeName === "IMG")) {
          return true;
        }
      }
      return false;
    },
    replacement(_content, node, options) {
      const href = node.getAttribute("href") || "";

      // Collect image markdown parts and text parts separately
      const imgParts = [];
      const textParts = [];

      for (const child of node.childNodes) {
        if (child.nodeType === 1 && child.nodeName === "IMG") {
          const src = child.getAttribute("src") || "";
          const alt = child.getAttribute("alt") || "";
          if (src) {
            imgParts.push(`![${alt}](${src})`);
          }
        } else {
          const text = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (text) {
            textParts.push(text);
          }
        }
      }

      const linkText = textParts.join(" -- ").trim() || href;
      const link = `[${linkText}](${href})`;

      if (imgParts.length > 0) {
        return `\n\n${imgParts.join("\n\n")}\n\n${link}\n\n`;
      }

      return `\n\n${link}\n\n`;
    },
  });

  // Custom rule: GFM table cells must be one physical line, but the gfm plugin
  // keeps newlines from <ul>/<li>/<br> inside <td>, which breaks the table into
  // an unrenderable multi-line blob. Override gfm's tableCell (addRule unshifts,
  // and forNode returns the first match, so this wins) and flatten internal
  // newlines + leading list markers into <br>-separated text (GFM renders <br>
  // inside a cell). Mirrors the plugin's own prefix logic.
  td.addRule("table-cell-flatten", {
    filter: ["th", "td"],
    replacement(content, node) {
      const flattened = content
        .replace(/\n+/g, "\n")
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*+]|•)\s+/, "").trim())
        .filter((line) => line.length > 0)
        .join("<br>");
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      const prefix = index === 0 ? "| " : " ";
      return `${prefix}${flattened} |`;
    },
  });

  let html = cleanHtml(page.mainHtml);
  html = replaceAnchorsWithLocalLinks(html, page, linkMap);
  html = replaceImagesWithLocalPaths(html, page, imageMap);
  html = stripLeadingBodyH1(html);

  const bodyMd = tidyConvertedMarkdown(td.turndown(html).trim(), path.posix.basename(page.relativePath));
  const header = renderSourceHeader(page.title, page.source);

  // The "Direct References" list is the bundle's purpose on the main entry (its
  // links are localized to the bundled reference files). On reference pages the
  // same list is just 40-plus non-localized external URLs -- noise -- so emit it
  // only for index.md.
  const isMainPage = page.relativePath === "index.md";
  const refSection = isMainPage ? buildReferenceSection(page, pageInfoMap, linkMap) : [];

  if (refSection.length > 0) {
    header.push("", ...refSection);
  }

  return `${header.join("\n")}\n\n${bodyMd}\n`;
}

function plannedReferencePath(outputDir, title, usedNames) {
  const base = sanitizeBaseName(title, "reference");
  let candidate = `${base}.md`;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base}-${suffix}.md`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return path.posix.join("references", candidate);
}

function fallbackTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = path.basename(parsed.pathname) || parsed.hostname;
    return name.replace(/[-_]+/g, " ");
  } catch {
    return url;
  }
}

function writeFailureStub(page, outputDir) {
  const body = `# ${page.title}\n\nSource: ${page.url}\n\nFailed to download this source.\n\nReason: ${page.failReason}\n`;
  const absolutePath = path.join(outputDir, page.relativePath);
  ensureDir(path.dirname(absolutePath));
  writeFileSync(absolutePath, body, "utf8");
}

function copySourceAsset(source, assetPath, outputDir) {
  const absoluteAssetPath = path.join(outputDir, assetPath);
  ensureDir(path.dirname(absoluteAssetPath));
  copyFileSync(source.preservedPath, absoluteAssetPath);
}

function createHtmlPage(source, classification, relativePath) {
  const html = readFileSync(source.preservedPath, "utf8");
  return {
    ...parsePage(source.finalUrl, html),
    relativePath,
    source,
    classification,
    kind: "html",
    failReason: null,
  };
}

function createTextPage(source, classification, relativePath) {
  const body = readFileSync(source.preservedPath, "utf8");
  return {
    url: source.finalUrl,
    title: titleFromTextSource(source, classification, body),
    html: null,
    mainHtml: "",
    articleHtml: "",
    directReferences: [],
    allLinks: [],
    images: [],
    relativePath,
    source,
    classification,
    kind: "text",
    markdown: renderTextSourceEntry(source, classification),
    failReason: null,
  };
}

function createAssetPage(source, classification, relativePath, assetPath, outputDir) {
  copySourceAsset(source, assetPath, outputDir);
  return {
    url: source.finalUrl,
    title: fallbackTitleFromUrl(source.finalUrl),
    html: null,
    mainHtml: "",
    articleHtml: "",
    directReferences: [],
    allLinks: [],
    images: [],
    relativePath,
    source,
    classification,
    kind: "asset",
    assetPath,
    markdown: renderAssetSourceEntry(source, assetPath, relativePath),
    failReason: null,
  };
}

function sourceAssetExtension(source, classification) {
  return (
    classification.extension ||
    sourceAssetExtensionFromContentType(source.contentType) ||
    sourceExtensionFromUrl(source.finalUrl) ||
    ".bin"
  );
}

function createPageFromSource(source, classification, relativePath, outputDir, assetPath = null) {
  if (classification.kind === "html") {
    return createHtmlPage(source, classification, relativePath);
  }

  if (classification.kind === "text") {
    return createTextPage(source, classification, relativePath);
  }

  return createAssetPage(source, classification, relativePath, assetPath, outputDir);
}

function addPageMapEntries(map, page) {
  map.set(page.url, page);
  if (page.source) {
    map.set(page.source.requestedUrl, page);
    map.set(page.source.fetchedUrl, page);
    map.set(page.source.finalUrl, page);
  }
}

function addLinkMapEntries(map, page) {
  map.set(page.url, page.relativePath);
  if (page.source) {
    map.set(page.source.requestedUrl, page.relativePath);
    map.set(page.source.fetchedUrl, page.relativePath);
    map.set(page.source.finalUrl, page.relativePath);
  }
}

function referenceManifestEntry(page) {
  const entry = {
    original_url: page.source?.requestedUrl || page.url,
    title: page.title,
    content_type: page.source?.contentType || "",
    kind: page.kind,
  };

  if (page.source?.finalUrl && page.source.finalUrl !== entry.original_url) {
    entry.final_url = page.source.finalUrl;
  }

  if (page.assetPath) {
    entry.asset_path = page.assetPath;
  }

  if (page.failReason) {
    entry.fail_reason = page.failReason;
  }

  return entry;
}

async function buildBundle(url, outDir, { svg2png = true } = {}) {
  const outputDir = path.resolve(outDir);
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  ensureDir(outputDir);
  const fetchDir = path.join(outputDir, ".fetch");
  ensureDir(fetchDir);

  console.error(`Fetching main source ${url} ...`);
  const mainSource = await fetchSource(url, path.join(fetchDir, "main.source"));
  const mainClassification = classifySource(mainSource);
  const mainAssetPath =
    mainClassification.kind === "asset" ? path.posix.join("assets", `source${sourceAssetExtension(mainSource, mainClassification)}`) : null;
  const mainPage = createPageFromSource(mainSource, mainClassification, "index.md", outputDir, mainAssetPath);

  const usedRefNames = new Set();
  const referencePages = [];
  let referenceIndex = 1;
  for (const refUrl of mainPage.directReferences || []) {
    console.error(`Fetching reference source ${refUrl} ...`);

    try {
      const source = await fetchSource(refUrl, path.join(fetchDir, `reference-${String(referenceIndex).padStart(3, "0")}.source`));
      const classification = classifySource(source);
      const title = (() => {
        if (classification.kind === "html") {
          const html = readFileSync(source.preservedPath, "utf8");
          const parsedTitle = extractTitle(html);
          return parsedTitle && parsedTitle !== "Untitled" ? parsedTitle : fallbackTitleFromUrl(source.finalUrl);
        }
        if (classification.kind === "text") {
          return titleFromTextSource(source, classification, readFileSync(source.preservedPath, "utf8"));
        }
        return fallbackTitleFromUrl(source.finalUrl);
      })();
      const relativePath = plannedReferencePath(outputDir, title, usedRefNames);
      const assetPath =
        classification.kind === "asset"
          ? path.posix.join("references", "assets", `${path.posix.basename(relativePath, ".md")}${sourceAssetExtension(source, classification)}`)
          : null;

      referencePages.push(createPageFromSource(source, classification, relativePath, outputDir, assetPath));
    } catch (error) {
      const title = fallbackTitleFromUrl(refUrl);
      const relativePath = plannedReferencePath(outputDir, title, usedRefNames);
      referencePages.push({
        url: refUrl,
        title,
        html: null,
        mainHtml: "",
        articleHtml: "",
        directReferences: [],
        allLinks: [],
        images: [],
        relativePath,
        source: null,
        classification: null,
        kind: "failed",
        failReason: error.message,
      });
    }

    referenceIndex += 1;
  }

  const allPages = [mainPage, ...referencePages];
  const pageInfoMap = new Map();
  const linkMap = new Map();

  for (const page of allPages) {
    addPageMapEntries(pageInfoMap, page);
    addLinkMapEntries(linkMap, page);
  }

  const pageImageMaps = new Map();
  for (const page of allPages) {
    if (page.kind !== "html") {
      pageImageMaps.set(page.url, new Map());
      continue;
    }

    const imageMap = await downloadImagesForPage(page, outputDir, { svg2png });
    pageImageMaps.set(page.url, imageMap);
  }

  for (const page of allPages) {
    const absolutePath = path.join(outputDir, page.relativePath);
    ensureDir(path.dirname(absolutePath));

    if (page.kind === "failed") {
      writeFailureStub(page, outputDir);
      continue;
    }

    if (page.kind !== "html") {
      writeFileSync(absolutePath, page.markdown, "utf8");
      continue;
    }

    const localizedLinks = new Map();
    for (const [targetUrl, targetPath] of linkMap.entries()) {
      localizedLinks.set(targetUrl, relativePosix(page.relativePath, targetPath));
    }

    const markdown = renderMarkdown(
      page,
      pageInfoMap,
      localizedLinks,
      pageImageMaps.get(page.url) || new Map(),
    );
    writeFileSync(absolutePath, markdown, "utf8");
  }

  const manifest = {};
  for (const page of referencePages) {
    manifest[page.relativePath] = referenceManifestEntry(page);
  }

  const manifestPath = path.join(outputDir, "references", "references.json");
  ensureDir(path.dirname(manifestPath));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const oldLinksPath = path.join(outputDir, "references", "links.txt");
  if (existsSync(oldLinksPath)) {
    rmSync(oldLinksPath, { force: true });
  }

  rmSync(fetchDir, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "bundle") {
    await buildBundle(args.url, args.outDir, { svg2png: args.svg2png });
  }
}

function isCliEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === thisFile;
  } catch {
    return path.resolve(process.argv[1]) === thisFile;
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  applySiteRules,
  buildBundle,
  classifySource,
  fetchSource,
  renderAssetSourceEntry,
  renderTextSourceEntry,
  shouldExcludeImage,
  SITE_RULES,
  stripGenericChrome,
  stripMdxComponents,
  tidyConvertedMarkdown,
  upgradeInitialUrl,
  validateSourceUrl,
};
