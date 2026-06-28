import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { downloadImagesForPage } from "./assets";
import { createDirectReferencePipeline } from "./direct-references";
import { writeReferenceManifest } from "./manifest";
import { parsePage } from "./page-extraction";
import {
  classifySource,
  fetchSource,
  sourceAssetExtension,
} from "./preserved-source";
import {
  renderAssetSourceEntry,
  renderMarkdown,
  renderTextSourceEntry,
} from "./rendering";
import {
  ensureDir,
  fallbackTitleFromUrl,
  relativePosix,
  titleFromTextSource,
} from "./shared";
import type {
  AssetBundlePage,
  AssetDirectReferenceOutcome,
  BuildBundleOptions,
  BuildBundleResult,
  BundlePage,
  DirectReferenceOutcome,
  FailedBundlePage,
  FetchedSource,
  HtmlBundlePage,
  HtmlSourceClassification,
  SourceClassification,
  TextBundlePage,
  TextSourceClassification,
} from "./types";

function writeFailureStub(page: FailedBundlePage, outputDir: string): void {
  const body = `# ${page.title}\n\nSource: ${page.url}\n\nFailed to download this source.\n\nReason: ${page.failReason}\n`;
  const absolutePath = path.join(outputDir, page.relativePath);
  ensureDir(path.dirname(absolutePath));
  writeFileSync(absolutePath, body, "utf8");
}

function copySourceAsset(
  source: FetchedSource,
  assetPath: string,
  outputDir: string,
): void {
  const absoluteAssetPath = path.join(outputDir, assetPath);
  ensureDir(path.dirname(absoluteAssetPath));
  copyFileSync(source.preservedPath, absoluteAssetPath);
}

function createHtmlPageFromParsedPage(
  source: FetchedSource,
  classification: HtmlSourceClassification,
  relativePath: string,
  parsedPage: ReturnType<typeof parsePage>,
): HtmlBundlePage {
  return {
    ...parsedPage,
    relativePath,
    source,
    classification,
    kind: "html",
    failReason: null,
  };
}

function createHtmlPage(
  source: FetchedSource,
  classification: HtmlSourceClassification,
  relativePath: string,
): HtmlBundlePage {
  const html = readFileSync(source.preservedPath, "utf8");
  return createHtmlPageFromParsedPage(
    source,
    classification,
    relativePath,
    parsePage(source.finalUrl, html),
  );
}

function createTextPage(
  source: FetchedSource,
  classification: TextSourceClassification,
  relativePath: string,
): TextBundlePage {
  const body = readFileSync(source.preservedPath, "utf8");
  return {
    url: source.finalUrl,
    title: titleFromTextSource(source, classification, body),
    html: null,
    mainHtml: "",
    articleHtml: "",
    directReferenceLinks: [],
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

function createAssetPage(
  source: FetchedSource,
  classification: AssetDirectReferenceOutcome["classification"],
  relativePath: string,
  assetPath: string,
  outputDir: string,
): AssetBundlePage {
  copySourceAsset(source, assetPath, outputDir);
  return {
    url: source.finalUrl,
    title: fallbackTitleFromUrl(source.finalUrl),
    html: null,
    mainHtml: "",
    articleHtml: "",
    directReferenceLinks: [],
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

function createPageFromSource(
  source: FetchedSource,
  classification: SourceClassification,
  relativePath: string,
  outputDir: string,
  assetPath: string | null = null,
): BundlePage {
  if (classification.kind === "html") {
    return createHtmlPage(source, classification, relativePath);
  }

  if (classification.kind === "text") {
    return createTextPage(source, classification, relativePath);
  }

  if (!assetPath) {
    throw new Error(`Expected asset path for asset source: ${source.finalUrl}`);
  }

  return createAssetPage(
    source,
    classification,
    relativePath,
    assetPath,
    outputDir,
  );
}

function createReferencePageFromOutcome(
  outcome: DirectReferenceOutcome,
  outputDir: string,
): BundlePage | null {
  if (outcome.kind === "skipped") {
    return null;
  }

  if (outcome.kind === "failed") {
    return {
      url: outcome.link.url,
      title: outcome.title,
      html: null,
      mainHtml: "",
      articleHtml: "",
      directReferenceLinks: [],
      directReferences: [],
      allLinks: [],
      images: [],
      relativePath: outcome.relativePath,
      source: null,
      classification: null,
      kind: "failed",
      failReason: outcome.failReason,
    };
  }

  if (outcome.kind === "asset") {
    return createAssetPage(
      outcome.source,
      outcome.classification,
      outcome.relativePath,
      outcome.assetPath,
      outputDir,
    );
  }

  if ("parsedPage" in outcome) {
    return createHtmlPageFromParsedPage(
      outcome.source,
      outcome.classification,
      outcome.relativePath,
      outcome.parsedPage,
    );
  }

  return createTextPage(
    outcome.source,
    outcome.classification,
    outcome.relativePath,
  );
}

function addPageMapEntries(
  map: Map<string, BundlePage>,
  page: BundlePage,
): void {
  map.set(page.url, page);
  if (page.source) {
    map.set(page.source.requestedUrl, page);
    map.set(page.source.fetchedUrl, page);
    map.set(page.source.finalUrl, page);
  }
}

function addLinkMapEntries(map: Map<string, string>, page: BundlePage): void {
  map.set(page.url, page.relativePath);
  if (page.source) {
    map.set(page.source.requestedUrl, page.relativePath);
    map.set(page.source.fetchedUrl, page.relativePath);
    map.set(page.source.finalUrl, page.relativePath);
  }
}

export async function buildBundle(
  url: string,
  outDir: string,
  { svg2png = true }: BuildBundleOptions = {},
): Promise<BuildBundleResult> {
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
    mainClassification.kind === "asset"
      ? path.posix.join(
          "assets",
          `source${sourceAssetExtension(mainSource, mainClassification)}`,
        )
      : null;
  const mainPage = createPageFromSource(
    mainSource,
    mainClassification,
    "index.md",
    outputDir,
    mainAssetPath,
  );

  const directReferencePipeline = createDirectReferencePipeline(mainPage.url);
  const referenceOutcomes: DirectReferenceOutcome[] = [];
  const referencePages: BundlePage[] = [];

  let referenceIndex = 1;
  for (const link of mainPage.directReferenceLinks) {
    const planned = directReferencePipeline.plan(link);
    if (planned.kind === "skipped") {
      console.error(`Skipping low-signal reference ${link.url} ...`);
      referenceOutcomes.push(planned);
      referenceIndex += 1;
      continue;
    }

    console.error(`Fetching reference source ${link.url} ...`);
    try {
      const source = await fetchSource(
        link.url,
        path.join(
          fetchDir,
          `reference-${String(referenceIndex).padStart(3, "0")}.source`,
        ),
      );
      const classification = classifySource(source);
      const parsedPage =
        classification.kind === "html"
          ? parsePage(
              source.finalUrl,
              readFileSync(source.preservedPath, "utf8"),
            )
          : null;
      const outcome = directReferencePipeline.resolveFetched({
        link,
        source,
        classification,
        parsedPage,
      });
      if (outcome.kind === "skipped") {
        console.error(`Skipping low-signal reference ${link.url} ...`);
      }
      referenceOutcomes.push(outcome);
      const page = createReferencePageFromOutcome(outcome, outputDir);
      if (page) {
        referencePages.push(page);
      }
    } catch (error) {
      const outcome = directReferencePipeline.resolveFailure(link, error);
      referenceOutcomes.push(outcome);
      const page = createReferencePageFromOutcome(outcome, outputDir);
      if (page) {
        referencePages.push(page);
      }
    }

    referenceIndex += 1;
  }

  const allPages = [mainPage, ...referencePages];
  const pageInfoMap = new Map<string, BundlePage>();
  const linkMap = new Map<string, string>();

  for (const page of allPages) {
    addPageMapEntries(pageInfoMap, page);
    addLinkMapEntries(linkMap, page);
  }

  const pageImageMaps = new Map<
    string,
    Map<string, import("./types").PageAssetOutcome>
  >();
  for (const page of allPages) {
    if (page.kind !== "html") {
      pageImageMaps.set(page.url, new Map());
      continue;
    }

    pageImageMaps.set(
      page.url,
      await downloadImagesForPage(page, outputDir, { svg2png }),
    );
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

    const localizedLinks = new Map<string, string>();
    for (const [targetUrl, targetPath] of linkMap.entries()) {
      localizedLinks.set(
        targetUrl,
        relativePosix(page.relativePath, targetPath),
      );
    }

    writeFileSync(
      absolutePath,
      renderMarkdown(
        page,
        pageInfoMap,
        localizedLinks,
        pageImageMaps.get(page.url) || new Map(),
      ),
      "utf8",
    );
  }

  writeReferenceManifest(referenceOutcomes, outputDir);
  rmSync(fetchDir, { recursive: true, force: true });

  return {
    outputDir,
    mainPage,
    referenceOutcomes,
  };
}
