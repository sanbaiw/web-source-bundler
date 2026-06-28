import { readFileSync } from "node:fs";
import path from "node:path";

import { sourceAssetExtension } from "./preserved-source";
import {
  fallbackTitleFromUrl,
  sanitizeBaseName,
  titleFromTextSource,
} from "./shared";
import type {
  DirectReferenceLink,
  DirectReferenceOutcome,
  DirectReferencePlan,
  FetchedSource,
  ParsedPage,
  SkippedDirectReferenceOutcome,
  SourceClassification,
} from "./types";

function normalizedHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isIpHostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function conservativeRegistrableDomain(hostname: string): string {
  const host = hostname.replace(/\.$/, "");
  if (!host || isIpHostname(host)) {
    return host;
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return host;
  }
  return parts.slice(-2).join(".");
}

function isSameSiteUrl(leftUrl: string, rightUrl: string): boolean {
  const leftHost = normalizedHostname(leftUrl);
  const rightHost = normalizedHostname(rightUrl);
  if (!leftHost || !rightHost) {
    return true;
  }
  if (isIpHostname(leftHost) || isIpHostname(rightHost)) {
    return leftHost === rightHost;
  }
  return (
    conservativeRegistrableDomain(leftHost) ===
    conservativeRegistrableDomain(rightHost)
  );
}

function isHomepageLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    return pathname === "/" || pathname === "/home";
  } catch {
    return false;
  }
}

const KNOWN_PRODUCT_HOMEPAGE_HOSTS = new Set([
  "bolt.new",
  "descript.com",
  "qodo.ai",
  "braintrust.dev",
  "claude.ai",
]);

const SOURCE_LIKE_HOSTS = [
  /(^|\.)github\.com$/i,
  /(^|\.)githubusercontent\.com$/i,
  /(^|\.)arxiv\.org$/i,
  /(^|\.)wikipedia\.org$/i,
];

const SOURCE_LIKE_SUBDOMAINS = new Set([
  "docs",
  "help",
  "developer",
  "developers",
  "api",
]);
const SOURCE_LIKE_PATH_PREFIXES = [
  "/docs",
  "/documentation",
  "/guide",
  "/guides",
  "/api",
  "/developer",
  "/developers",
  "/blog",
  "/engineering",
  "/research",
  "/paper",
  "/papers",
  "/article",
  "/articles",
  "/case-studies",
  "/customers",
];
const SOURCE_LIKE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".xml",
  ".csv",
  ".yaml",
  ".yml",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".zip",
  ".gz",
  ".tar",
  ".docx",
  ".pptx",
  ".xlsx",
]);

function normalizedPathname(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/g, "") || "/";
  } catch {
    return "/";
  }
}

function isSourceLikeReferenceUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const host = normalizedHostname(url);
  if (SOURCE_LIKE_HOSTS.some((pattern) => pattern.test(host))) {
    return true;
  }

  const firstLabel = host.split(".")[0] ?? "";
  if (SOURCE_LIKE_SUBDOMAINS.has(firstLabel)) {
    return true;
  }

  const pathname = normalizedPathname(url).toLowerCase();
  if (
    SOURCE_LIKE_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }

  return SOURCE_LIKE_EXTENSIONS.has(
    path.extname(parsed.pathname).toLowerCase(),
  );
}

function isKnownProductHomepageOrLandingUrl(url: string): boolean {
  const host = normalizedHostname(url);
  const pathname = normalizedPathname(url).toLowerCase();

  if (KNOWN_PRODUCT_HOMEPAGE_HOSTS.has(host) && isHomepageLikeUrl(url)) {
    return true;
  }

  return (
    (host === "anthropic.com" && pathname === "/claude-code") ||
    (host === "claude.com" && pathname === "/product/claude-code") ||
    (host === "claude.ai" && pathname === "/code")
  );
}

export function shouldSkipReferenceBeforeFetch({
  mainUrl,
  referenceUrl,
}: {
  mainUrl: string;
  referenceUrl: string;
}): {
  kind: "skipped";
  skipped_reason: "low_signal_marketing_reference";
} | null {
  if (isSameSiteUrl(mainUrl, referenceUrl)) {
    return null;
  }
  if (isSourceLikeReferenceUrl(referenceUrl)) {
    return null;
  }
  if (!isKnownProductHomepageOrLandingUrl(referenceUrl)) {
    return null;
  }

  return {
    kind: "skipped",
    skipped_reason: "low_signal_marketing_reference",
  };
}

function marketingSignalsForHtml(page: ParsedPage): Set<string> {
  const html = page.mainHtml || page.articleHtml || "";
  const text = html.replace(/<[^>]+>/g, " ").toLowerCase();
  const signals = new Set<string>();

  if (
    /\b(?:get started|start for free|try for free|sign up|signup|book a demo|contact sales)\b/i.test(
      text,
    )
  ) {
    signals.add("cta");
  }
  if (
    /\b(?:trusted by|customers|customer stories|testimonials?|logo wall)\b/i.test(
      text,
    )
  ) {
    signals.add("social-proof");
  }
  if (/\bpricing\b|\bfree\b[\s\S]{0,80}\b(?:pro|enterprise)\b/i.test(text)) {
    signals.add("pricing");
  }
  if (/<form\b/i.test(html) || /\bnewsletter\b/i.test(text)) {
    signals.add("form");
  }

  return signals;
}

export function isLowSignalMarketingReference({
  mainUrl,
  referenceUrl,
  page,
}: {
  mainUrl: string;
  referenceUrl: string;
  page: ParsedPage;
}): boolean {
  if (isSameSiteUrl(mainUrl, referenceUrl)) {
    return false;
  }
  if (isSourceLikeReferenceUrl(referenceUrl)) {
    return false;
  }
  if (
    !isHomepageLikeUrl(referenceUrl) &&
    !isKnownProductHomepageOrLandingUrl(referenceUrl)
  ) {
    return false;
  }
  return marketingSignalsForHtml(page).size >= 2;
}

function plannedReferencePath(title: string, usedNames: Set<string>): string {
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

function deriveReferenceTitle(
  source: FetchedSource,
  classification: SourceClassification,
  parsedPage: ParsedPage | null,
): string {
  if (classification.kind === "html") {
    return parsedPage?.title && parsedPage.title !== "Untitled"
      ? parsedPage.title
      : fallbackTitleFromUrl(source.finalUrl);
  }
  if (classification.kind === "text") {
    return titleFromTextSource(
      source,
      classification,
      readFileSync(source.preservedPath, "utf8"),
    );
  }
  return fallbackTitleFromUrl(source.finalUrl);
}

function skippedOutcome(
  link: DirectReferenceLink,
  source: FetchedSource | null,
  title: string | null,
): SkippedDirectReferenceOutcome {
  return {
    kind: "skipped",
    link,
    source,
    title,
    skippedReason: "low_signal_marketing_reference",
  };
}

interface DirectReferencePipeline {
  plan(link: DirectReferenceLink): DirectReferencePlan;
  resolveFetched(args: {
    link: DirectReferenceLink;
    source: FetchedSource;
    classification: SourceClassification;
    parsedPage: ParsedPage | null;
  }): DirectReferenceOutcome;
  resolveFailure(
    link: DirectReferenceLink,
    error: unknown,
  ): DirectReferenceOutcome;
}

export function createDirectReferencePipeline(
  mainUrl: string,
): DirectReferencePipeline {
  const usedNames = new Set<string>();

  return {
    plan(link) {
      return shouldSkipReferenceBeforeFetch({ mainUrl, referenceUrl: link.url })
        ? skippedOutcome(link, null, null)
        : { kind: "fetch", link };
    },
    resolveFetched({ link, source, classification, parsedPage }) {
      const title = deriveReferenceTitle(source, classification, parsedPage);

      if (
        classification.kind === "html" &&
        parsedPage &&
        isLowSignalMarketingReference({
          mainUrl,
          referenceUrl: source.finalUrl,
          page: parsedPage,
        })
      ) {
        return skippedOutcome(link, source, title);
      }

      const relativePath = plannedReferencePath(title, usedNames);
      if (classification.kind === "asset") {
        return {
          kind: "asset",
          link,
          source,
          classification,
          title,
          relativePath,
          assetPath: path.posix.join(
            "references",
            "assets",
            `${path.posix.basename(relativePath, ".md")}${sourceAssetExtension(source, classification)}`,
          ),
        };
      }

      if (classification.kind === "html") {
        if (!parsedPage) {
          throw new Error(
            `Expected parsed page for HTML direct reference: ${source.finalUrl}`,
          );
        }
        return {
          kind: "readable",
          link,
          source,
          classification,
          title,
          relativePath,
          parsedPage,
        };
      }

      return {
        kind: "readable",
        link,
        source,
        classification,
        title,
        relativePath,
      };
    },
    resolveFailure(link, error) {
      const title = fallbackTitleFromUrl(link.url);
      return {
        kind: "failed",
        link,
        title,
        relativePath: plannedReferencePath(title, usedNames),
        failReason: error instanceof Error ? error.message : String(error),
      };
    },
  };
}
