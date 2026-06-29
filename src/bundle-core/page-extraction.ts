import path from "node:path";

import {
  absoluteUrlForAsset,
  decodeHtml,
  documentUrlKey,
  normalizeUrl,
  sanitizeBaseName,
  stripTags,
} from "./shared";
import type {
  DirectReferenceLink,
  PageImageCandidate,
  ParsedPage,
} from "./types";

interface SiteRule {
  id: string;
  test(hostname: string): boolean;
  clean(html: string): string;
}

function extractMain(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) {
    return main[1] ?? html;
  }

  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

function extractArticle(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return article?.[1] ?? html;
}

function extractTitle(html: string): string {
  const ogTitle = html.match(
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
  );
  if (ogTitle?.[1] && stripTags(ogTitle[1])) {
    return stripTags(ogTitle[1]);
  }

  const metaTitle = html.match(
    /<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i,
  );
  if (metaTitle?.[1] && stripTags(metaTitle[1])) {
    return stripTags(metaTitle[1]);
  }

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) {
    return stripTags(h1[1]);
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) {
    return "Untitled";
  }

  return stripTags(title[1] ?? "")
    .replace(/\s*[|\\-]\\s*anthropic$/i, "")
    .replace(/\s*[|\\-]\\s*wikipedia$/i, "")
    .trim();
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/\sclass="[^"]*"/gi, "")
    .replace(/\sstyle="[^"]*"/gi, "");
}

function removeBalancedTag(
  html: string,
  tagName: string,
  attrTest: (attrs: string) => boolean,
): string {
  const open = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const tagPair = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  let result = html;
  let guard = 0;
  while (guard < 1000) {
    guard += 1;
    open.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    for (
      let candidate = open.exec(result);
      candidate;
      candidate = open.exec(result)
    ) {
      if (attrTest(candidate[1] || "")) {
        match = candidate;
        break;
      }
    }
    if (!match) {
      return result;
    }

    const start = match.index ?? 0;
    tagPair.lastIndex = start;
    let depth = 0;
    let end = -1;
    for (
      let tagMatch = tagPair.exec(result);
      tagMatch;
      tagMatch = tagPair.exec(result)
    ) {
      depth += tagMatch[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = (tagMatch.index ?? 0) + tagMatch[0].length;
        break;
      }
    }
    if (end === -1) {
      return result;
    }
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

function attrValue(attrs: string, attr: string): string | null {
  const quoted = attrs.match(
    new RegExp(`\\b${attr}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  if (quoted) {
    return quoted[2] ?? null;
  }
  const bare = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*([^\\s>]+)`, "i"));
  return bare?.[1] ?? null;
}

function attrHasRole(attrs: string, ...roles: string[]): boolean {
  const value = attrValue(attrs, "role");
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return roles.some((role) => normalized.split(/\s+/).includes(role));
}

function attrMatches(attrs: string, attr: string, pattern: RegExp): boolean {
  const value = attrValue(attrs, attr);
  if (!value) {
    return false;
  }
  return pattern.test(value);
}

export function stripGenericChrome(html: string): string {
  let cleaned = html;
  for (const tagName of ["nav", "header", "footer", "aside"]) {
    cleaned = removeBalancedTag(cleaned, tagName, () => true);
  }
  cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
    attrHasRole(
      attrs,
      "navigation",
      "complementary",
      "banner",
      "contentinfo",
      "search",
    ),
  );
  cleaned = removeBalancedTag(cleaned, "section", (attrs) =>
    attrHasRole(attrs, "navigation", "complementary"),
  );
  return cleaned.replace(/\[\s*edit\s*\]/gi, "");
}

const SITE_RULES: SiteRule[] = [
  {
    id: "arxiv",
    test: (hostname) => /(^|\.)arxiv\.org$/i.test(hostname),
    clean(html) {
      let cleaned = html;
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\bsubheader\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\bheader-breadcrumbs-mobile\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\bbrowse\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\bextra-ref-cite\b/i),
      );
      cleaned = cleaned.replace(
        /<a\b[^>]*class="[^"]*\bmobile-submission-download\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
        "",
      );
      const cut = cleaned.search(
        /<h3>\s*References\s*&amp;\s*Citations\s*<\/h3>|<h3>\s*References\s*&\s*Citations\s*<\/h3>/i,
      );
      cleaned = cut === -1 ? cleaned : cleaned.slice(0, cut);
      const toolsCut = cleaned.search(
        /<div\b[^>]*(?:id\s*=\s*['"]bib-cite-modal['"]|class\s*=\s*['"]bookmarks['"]|id\s*=\s*['"]labstabs['"])/i,
      );
      return toolsCut === -1 ? cleaned : cleaned.slice(0, toolsCut);
    },
  },
  {
    id: "wikipedia",
    test: (hostname) => /(^|\.)wikipedia\.org$/i.test(hostname),
    clean(html) {
      let cleaned = html;
      const parserOutput =
        cleaned.match(
          /<div id="mw-content-text"[^>]*>[\s\S]*?<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*(?:<noscript|<div class="printfooter"|<div id="catlinks")/i,
        ) ||
        cleaned.match(
          /<div class="mw-content-ltr mw-parser-output"[^>]*>([\s\S]*?)<\/div>\s*(?:<noscript|<div class="printfooter"|<div id="catlinks")/i,
        );
      if (parserOutput) {
        cleaned = parserOutput[1] ?? cleaned;
      }
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\breflist\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "class", /\bnavbox\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "div", (attrs) =>
        attrMatches(attrs, "id", /\bcatlinks\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "span", (attrs) =>
        attrMatches(attrs, "class", /\bmw-editsection\b/i),
      );
      cleaned = removeBalancedTag(cleaned, "table", (attrs) =>
        attrMatches(attrs, "class", /\bnavbox\b/i),
      );
      cleaned = cleaned.replace(
        /<div[^>]*class="[^"]*\bshortdescription\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
        "",
      );
      cleaned = cleaned.replace(
        /<div[^>]*class="[^"]*\bmw-subjectpageheader\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
        "",
      );
      cleaned = cleaned.replace(
        /<p\b[^>]*class="[^"]*\bmw-empty-elt\b[^"]*"[^>]*>\s*<\/p>/gi,
        "",
      );
      cleaned = cleaned.replace(
        /<meta\b[^>]*property="mw:PageProp\/toc"[^>]*>/gi,
        "",
      );
      const cut = cleaned.search(
        /<div\b[^>]*class="[^"]*\bmw-heading\b[^"]*"[^>]*>\s*<h2\b[^>]*id="(?:References|External_links)"/i,
      );
      return cut === -1 ? cleaned : cleaned.slice(0, cut);
    },
  },
  {
    id: "github",
    test: (hostname) => /(^|\.)github\.com$/i.test(hostname),
    clean(html) {
      const readme = html.match(
        /<article\b[^>]*class="[^"]*markdown-body[^"]*"[^>]*>[\s\S]*?<\/article>/i,
      );
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
      cleaned = cleaned
        .replace(/<h1\b([^>]*)>/i, "<h2$1>")
        .replace(/<\/h1>/i, "</h2>");
      cleaned = removeBalancedTag(cleaned, "button", () => true);
      cleaned = removeBalancedTag(cleaned, "input", () => true);
      cleaned = cleaned.replace(
        /<p\b[^>]*>\s*or\s+import\s+from\s*<\/p>/gi,
        "",
      );

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
        return first === -1
          ? (match.index ?? -1)
          : Math.min(first, match.index ?? first);
      }, -1);

      return cut === -1 ? cleaned : `${cleaned.slice(0, cut)}</body></html>`;
    },
  },
];

export function applySiteRules(html: string, url: string): string {
  let hostname: string;
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

function stripLeadingBodyH1(html: string): string {
  const match = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/i);
  if (!match || match.index == null) {
    return html;
  }

  return `${html.slice(0, match.index)}${html.slice(match.index + match[0].length)}`.trimStart();
}

function readableLinkLabel(html: string): string | null {
  const label = stripTags(html);
  if (!label || isChromeName(sanitizeBaseName(label, ""))) {
    return null;
  }
  return label;
}

function extractLinkEntries(
  html: string,
  baseUrl: string,
): DirectReferenceLink[] {
  const references: DirectReferenceLink[] = [];
  const byUrl = new Map<string, DirectReferenceLink>();
  const linkPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    const url = normalizeUrl(baseUrl, match[1]);
    if (!url) {
      continue;
    }

    const label = readableLinkLabel(match[2] || "");
    const key = documentUrlKey(url);
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.label && label) {
        existing.label = label;
      }
      continue;
    }

    const entry = label ? { url, label } : { url };
    byUrl.set(key, entry);
    references.push(entry);
  }

  return references;
}

function extractLinks(html: string, baseUrl: string): string[] {
  return extractLinkEntries(html, baseUrl).map((entry) => entry.url);
}

function extractImages(html: string, baseUrl: string): PageImageCandidate[] {
  const images: PageImageCandidate[] = [];
  const imagePattern = /<img\b[^>]*src="([^"]+)"[^>]*>/gi;

  for (const match of html.matchAll(imagePattern)) {
    const rawTag = match[0];
    const url = absoluteUrlForAsset(match[1] || "", baseUrl);
    if (!url) {
      continue;
    }

    const altMatch = rawTag.match(/\balt="([^"]*)"/i);
    const alt = altMatch?.[1] ? decodeHtml(altMatch[1]) : "";
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

const CHROME_NAME_TOKENS = new Set([
  "logo",
  "icon",
  "avatar",
  "pixel",
  "spacer",
  "badge",
]);

function isChromeName(name: string): boolean {
  if (!name) {
    return false;
  }
  if (
    name === "logo" ||
    name.endsWith("-logo") ||
    name.includes("-logo-") ||
    name.startsWith("logo-")
  ) {
    return true;
  }
  return name.split("-").some((token) => CHROME_NAME_TOKENS.has(token));
}

export function shouldExcludeImage(url: string, alt = ""): boolean {
  const normalizedAlt = sanitizeBaseName(alt, "");
  if (isChromeName(normalizedAlt)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const fileName = sanitizeBaseName(
      path.basename(parsed.pathname, path.extname(parsed.pathname)),
      "",
    );
    return isChromeName(fileName);
  } catch {
    return false;
  }
}

export function parsePage(url: string, html: string): ParsedPage {
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
    directReferenceLinks: extractLinkEntries(articleHtml, url),
    directReferences: extractLinks(articleHtml, url),
    allLinks: extractLinks(mainHtml, url),
    images: extractImages(articleHtml, url),
  };
}

export { cleanHtml, stripLeadingBodyH1 };
