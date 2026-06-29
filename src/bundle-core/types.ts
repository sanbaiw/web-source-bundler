export interface BuildBundleOptions {
  svg2png?: boolean;
}

export interface DirectReferenceLink {
  url: string;
  label?: string;
}

export interface PageImageCandidate {
  url: string;
  alt: string;
}

export interface FetchedSource {
  requestedUrl: string;
  fetchedUrl: string;
  finalUrl: string;
  status: number | null;
  contentType: string;
  preservedPath: string;
  failReason: null;
  fetchMethod: "fetch" | "curl-fallback";
}

export interface HtmlSourceClassification {
  kind: "html";
  subtype: "html";
  language: "html";
  render: "html";
  extension: ".html";
}

export interface TextSourceClassification {
  kind: "text";
  subtype: string;
  language: string;
  render: "direct" | "fenced";
  extension: string;
}

export interface AssetSourceClassification {
  kind: "asset";
  subtype: string;
  language: "";
  render: "asset";
  extension: string;
}

export type SourceClassification =
  | HtmlSourceClassification
  | TextSourceClassification
  | AssetSourceClassification;

export interface ParsedPage {
  url: string;
  title: string;
  html: string;
  mainHtml: string;
  articleHtml: string;
  directReferenceLinks: DirectReferenceLink[];
  directReferences: string[];
  allLinks: string[];
  images: PageImageCandidate[];
}

interface BundlePageBase {
  url: string;
  title: string;
  html: string | null;
  mainHtml: string;
  articleHtml: string;
  directReferenceLinks: DirectReferenceLink[];
  directReferences: string[];
  allLinks: string[];
  images: PageImageCandidate[];
  relativePath: string;
  source: FetchedSource | null;
  classification: SourceClassification | null;
  failReason: string | null;
}

export interface HtmlBundlePage extends BundlePageBase {
  kind: "html";
  html: string;
  source: FetchedSource;
  classification: HtmlSourceClassification;
  failReason: null;
}

export interface TextBundlePage extends BundlePageBase {
  kind: "text";
  source: FetchedSource;
  classification: TextSourceClassification;
  markdown: string;
  failReason: null;
}

export interface AssetBundlePage extends BundlePageBase {
  kind: "asset";
  source: FetchedSource;
  classification: AssetSourceClassification;
  assetPath: string;
  markdown: string;
  failReason: null;
}

export interface FailedBundlePage extends BundlePageBase {
  kind: "failed";
  html: null;
  source: null;
  classification: null;
  failReason: string;
}

export type BundlePage =
  | HtmlBundlePage
  | TextBundlePage
  | AssetBundlePage
  | FailedBundlePage;

export interface LocalizedAssetOutcome {
  kind: "localized";
  sourceUrl: string;
  relativePath: string;
}

export interface DroppedAssetOutcome {
  kind: "dropped";
  sourceUrl: string;
  reason: "not_image" | "too_small_bytes" | "tiny_dimensions";
}

export interface FailedAssetOutcome {
  kind: "failed";
  sourceUrl: string;
  failReason: string;
}

export type PageAssetOutcome =
  | LocalizedAssetOutcome
  | DroppedAssetOutcome
  | FailedAssetOutcome;

export interface SkippedDirectReferenceOutcome {
  kind: "skipped";
  link: DirectReferenceLink;
  source: FetchedSource | null;
  title: string | null;
  skippedReason: "low_signal_marketing_reference";
}

export interface HtmlDirectReferenceOutcome {
  kind: "readable";
  link: DirectReferenceLink;
  source: FetchedSource;
  classification: HtmlSourceClassification;
  title: string;
  relativePath: string;
  parsedPage: ParsedPage;
}

export interface TextDirectReferenceOutcome {
  kind: "readable";
  link: DirectReferenceLink;
  source: FetchedSource;
  classification: TextSourceClassification;
  title: string;
  relativePath: string;
}

export interface AssetDirectReferenceOutcome {
  kind: "asset";
  link: DirectReferenceLink;
  source: FetchedSource;
  classification: AssetSourceClassification;
  title: string;
  relativePath: string;
  assetPath: string;
}

export interface FailedDirectReferenceOutcome {
  kind: "failed";
  link: DirectReferenceLink;
  title: string;
  relativePath: string;
  failReason: string;
}

export interface AliasDirectReferenceOutcome {
  kind: "alias";
  link: DirectReferenceLink;
  source: FetchedSource;
  title: string;
  relativePath: string;
}

export type DirectReferenceOutcome =
  | HtmlDirectReferenceOutcome
  | TextDirectReferenceOutcome
  | AssetDirectReferenceOutcome
  | FailedDirectReferenceOutcome
  | SkippedDirectReferenceOutcome
  | AliasDirectReferenceOutcome;

export type DirectReferencePlan =
  | { kind: "fetch"; link: DirectReferenceLink }
  | SkippedDirectReferenceOutcome;

export interface ReferenceManifestEntry {
  original_url: string;
  title: string;
  content_type: string;
  kind: "html" | "text" | "asset" | "failed";
  final_url?: string;
  asset_path?: string;
  fail_reason?: string;
  additional_original_urls?: string[];
}

export interface SkippedReferenceManifestEntry {
  original_url: string;
  kind: "skipped";
  skipped_reason: "low_signal_marketing_reference";
  label?: string;
  title?: string;
  final_url?: string;
  content_type?: string;
}

export interface BuildBundleResult {
  outputDir: string;
  mainPage: BundlePage;
  referenceOutcomes: DirectReferenceOutcome[];
}
