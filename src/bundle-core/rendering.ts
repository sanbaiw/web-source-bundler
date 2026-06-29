import { readFileSync } from "node:fs";
import path from "node:path";

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { replaceImagesWithLocalPaths } from "./assets";
import { cleanHtml, stripLeadingBodyH1 } from "./page-extraction";
import {
  documentUrlKey,
  fallbackTitleFromUrl,
  normalizeUrl,
  relativePosix,
  sanitizeBaseName,
  titleFromTextSource,
} from "./shared";
import type {
  AssetBundlePage,
  BundlePage,
  FetchedSource,
  HtmlBundlePage,
  PageAssetOutcome,
  TextBundlePage,
  TextSourceClassification,
} from "./types";

function buildReferenceSection(
  page: HtmlBundlePage,
  pageInfoMap: Map<string, BundlePage>,
  linkMap: Map<string, string>,
): string[] {
  if (page.directReferences.length === 0) {
    return [];
  }

  const lines = ["## Direct References", ""];
  const seenTargets = new Set<string>();
  for (const referenceUrl of page.directReferences) {
    const info =
      pageInfoMap.get(referenceUrl) ||
      pageInfoMap.get(documentUrlKey(referenceUrl));
    const localTarget =
      linkMap.get(referenceUrl) || linkMap.get(documentUrlKey(referenceUrl));
    const label = info?.title || referenceUrl;
    if (localTarget) {
      if (seenTargets.has(localTarget)) {
        continue;
      }
      seenTargets.add(localTarget);
      lines.push(`- [${label}](${localTarget})`);
    }
  }

  return lines.length > 2 ? lines : [];
}

function buildProvenanceLines(source: FetchedSource): string[] {
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

function renderSourceHeader(title: string, source: FetchedSource): string[] {
  return [`# ${title}`, "", ...buildProvenanceLines(source)];
}

function stripLeadingLlmsTxtPreamble(body: string): string {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith(">")) {
    return body;
  }

  const lines = trimmed.split("\n");
  let end = 0;
  while (end < lines.length && lines[end]?.startsWith(">")) {
    end += 1;
  }

  const block = lines.slice(0, end).join("\n");
  if (!/documentation index|llms\.txt/i.test(block)) {
    return body;
  }

  let rest = end;
  while (rest < lines.length && lines[rest]?.trim() === "") {
    rest += 1;
  }
  return lines.slice(rest).join("\n");
}

function stripLeadingMarkdownH1(body: string, title: string): string {
  const trimmed = body.replace(/^\s+/, "");
  const match = trimmed.match(/^#\s+(.+?)\s*(?:\n|$)/);
  if (!match || sanitizeBaseName(match[1] ?? "") !== sanitizeBaseName(title)) {
    return body;
  }
  return trimmed.slice(match[0].length).replace(/^\s+/, "");
}

function closingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function fenceForBody(body: string): string {
  const longestBacktickRun = Math.max(
    2,
    ...[...body.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(longestBacktickRun + 1);
}

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

function stripMdxComponents(body: string): string {
  let cleaned = body;
  for (const tag of MDX_WRAPPER_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*?/>`, "g"), "");
    cleaned = cleaned.replace(new RegExp(`</?${tag}\\b[^>]*?>`, "g"), "");
  }
  cleaned = cleaned.replace(/<\/?div\b[^>]*>/g, "");
  cleaned = cleaned.replace(/[ \t]+theme=\{null\}/g, "");
  return cleaned.replace(/\n{3,}/g, "\n\n");
}

function tidyMarkdownBody(body: string, title: string): string {
  let cleaned = stripLeadingLlmsTxtPreamble(body);
  cleaned = stripLeadingMarkdownH1(cleaned, title);
  cleaned = stripMdxComponents(cleaned);
  return cleaned;
}

export function renderTextSourceEntry(
  source: FetchedSource,
  classification: TextSourceClassification,
): string {
  const body = readFileSync(source.preservedPath, "utf8");
  const title = titleFromTextSource(source, classification, body);
  const header = renderSourceHeader(title, source);

  if (classification.render === "direct") {
    const rendered =
      classification.subtype === "markdown"
        ? tidyMarkdownBody(body, title)
        : body;
    return `${header.join("\n")}\n\n${closingNewline(rendered)}`;
  }

  const fence = fenceForBody(body);
  const language = classification.language || "text";
  return `${header.join("\n")}\n\n${fence}${language}\n${closingNewline(body)}${fence}\n`;
}

export function renderAssetSourceEntry(
  source: FetchedSource,
  assetPath: string,
  markdownPath: string,
): string {
  const title = fallbackTitleFromUrl(source.finalUrl);
  const localAssetPath = relativePosix(markdownPath, assetPath);
  const header = renderSourceHeader(title, source);

  return `${header.join("\n")}\n\nOriginal source asset: [${localAssetPath}](${localAssetPath})\n\nText extraction is deferred to a specialized pipeline.\n`;
}

export function tidyConvertedMarkdown(markdown: string, selfName = ""): string {
  let cleaned = markdown.replace(
    /\[\s*\]\((?:[^)]*)\)/g,
    (match, offset, source) =>
      offset > 0 && source[offset - 1] === "!" ? match : "",
  );
  if (selfName) {
    const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selfLink = new RegExp(
      `\\[([^\\]]*)\\]\\(\\.?/?${escaped}(?:#[^)]*)?\\)`,
      "g",
    );
    cleaned = cleaned.replace(selfLink, "$1");
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function replaceAnchorsWithLocalLinks(
  html: string,
  page: HtmlBundlePage,
  linkMap: Map<string, string>,
): string {
  return html.replace(
    /(<a\b[^>]*href=")([^"]+)("[^>]*>)/gi,
    (full, start, href, end) => {
      const absolute = normalizeUrl(page.url, href);
      if (!absolute) {
        return full;
      }

      const localTarget =
        linkMap.get(absolute) || linkMap.get(documentUrlKey(absolute));
      if (!localTarget) {
        if (/^(?:#|mailto:|tel:|javascript:)/i.test(href)) {
          return full;
        }
        return `${start}${absolute}${end}`;
      }

      return `${start}${localTarget}${end}`;
    },
  );
}

export function renderMarkdown(
  page: HtmlBundlePage,
  pageInfoMap: Map<string, BundlePage>,
  linkMap: Map<string, string>,
  imageOutcomes: Map<string, PageAssetOutcome>,
): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  turndown.use(gfm);
  turndown.remove(["script", "style", "nav", "footer", "header", "noscript"]);

  const BLOCK_TAGS = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "DIV",
    "FIGURE",
    "PICTURE",
    "SECTION",
  ]);
  turndown.addRule("card-link", {
    filter(node) {
      if (node.nodeName !== "A") {
        return false;
      }
      const element = node as Element;
      if (!element.getAttribute("href")) {
        return false;
      }
      for (const child of Array.from(element.childNodes)) {
        if (
          child.nodeType === 1 &&
          (BLOCK_TAGS.has(child.nodeName) || child.nodeName === "IMG")
        ) {
          return true;
        }
      }
      return false;
    },
    replacement(_content, node) {
      const element = node as Element;
      const href = element.getAttribute("href") || "";

      const imageParts: string[] = [];
      const textParts: string[] = [];

      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 1 && child.nodeName === "IMG") {
          const image = child as Element;
          const src = image.getAttribute("src") || "";
          const alt = image.getAttribute("alt") || "";
          if (src) {
            imageParts.push(`![${alt}](${src})`);
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

      if (imageParts.length > 0) {
        return `\n\n${imageParts.join("\n\n")}\n\n${link}\n\n`;
      }

      return `\n\n${link}\n\n`;
    },
  });

  turndown.addRule("table-cell-flatten", {
    filter: ["th", "td"],
    replacement(content, node) {
      const flattened = content
        .replace(/\n+/g, "\n")
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*+]|•)\s+/, "").trim())
        .filter((line) => line.length > 0)
        .join("<br>");
      const tableCell = node as Element;
      const parent = tableCell.parentNode;
      const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, tableCell)
        : 0;
      const prefix = index === 0 ? "| " : " ";
      return `${prefix}${flattened} |`;
    },
  });

  let html = cleanHtml(page.mainHtml);
  html = replaceAnchorsWithLocalLinks(html, page, linkMap);
  html = replaceImagesWithLocalPaths(html, page.url, imageOutcomes);
  html = stripLeadingBodyH1(html);

  const bodyMarkdown = tidyConvertedMarkdown(
    turndown.turndown(html).trim(),
    path.posix.basename(page.relativePath),
  );
  const header = renderSourceHeader(page.title, page.source);
  const isMainPage = page.relativePath === "index.md";
  const referenceSection = isMainPage
    ? buildReferenceSection(page, pageInfoMap, linkMap)
    : [];

  if (referenceSection.length > 0) {
    header.push("", ...referenceSection);
  }

  return `${header.join("\n")}\n\n${bodyMarkdown}\n`;
}
