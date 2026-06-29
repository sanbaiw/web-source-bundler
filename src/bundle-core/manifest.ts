import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureDir } from "./shared";
import type {
  DirectReferenceOutcome,
  ReferenceManifestEntry,
  SkippedReferenceManifestEntry,
} from "./types";

export function writeReferenceManifest(
  referenceOutcomes: DirectReferenceOutcome[],
  outputDir: string,
): void {
  const manifestEntries: Record<string, ReferenceManifestEntry> = {};
  const skippedEntries: Record<string, SkippedReferenceManifestEntry> = {};

  for (const outcome of referenceOutcomes) {
    if (outcome.kind === "skipped") {
      skippedEntries[outcome.link.url] = {
        original_url: outcome.link.url,
        kind: "skipped",
        skipped_reason: outcome.skippedReason,
        ...(outcome.link.label ? { label: outcome.link.label } : {}),
        ...(outcome.title ? { title: outcome.title } : {}),
        ...(outcome.source?.finalUrl &&
        outcome.source.finalUrl !== outcome.link.url
          ? { final_url: outcome.source.finalUrl }
          : {}),
        ...(outcome.source?.contentType
          ? { content_type: outcome.source.contentType }
          : {}),
      };
      continue;
    }

    if (outcome.kind === "alias") {
      const entry = manifestEntries[outcome.relativePath];
      if (entry && outcome.link.url !== entry.original_url) {
        const aliases = new Set(entry.additional_original_urls || []);
        aliases.add(outcome.link.url);
        entry.additional_original_urls = [...aliases];
      }
      continue;
    }

    if (outcome.kind === "failed") {
      manifestEntries[outcome.relativePath] = {
        original_url: outcome.link.url,
        title: outcome.title,
        content_type: "",
        kind: "failed",
        fail_reason: outcome.failReason,
      };
      continue;
    }

    if (outcome.kind === "asset") {
      manifestEntries[outcome.relativePath] = {
        original_url: outcome.source.requestedUrl,
        title: outcome.title,
        content_type: outcome.source.contentType || "",
        kind: "asset",
        ...(outcome.source.finalUrl !== outcome.source.requestedUrl
          ? { final_url: outcome.source.finalUrl }
          : {}),
        asset_path: outcome.assetPath,
      };
      continue;
    }

    manifestEntries[outcome.relativePath] = {
      original_url: outcome.source.requestedUrl,
      title: outcome.title,
      content_type: outcome.source.contentType || "",
      kind: outcome.classification.kind === "html" ? "html" : "text",
      ...(outcome.source.finalUrl !== outcome.source.requestedUrl
        ? { final_url: outcome.source.finalUrl }
        : {}),
    };
  }

  const manifest =
    Object.keys(skippedEntries).length > 0
      ? { ...manifestEntries, skipped: skippedEntries }
      : manifestEntries;

  const manifestPath = path.join(outputDir, "references", "references.json");
  ensureDir(path.dirname(manifestPath));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const oldLinksPath = path.join(outputDir, "references", "links.txt");
  if (existsSync(oldLinksPath)) {
    rmSync(oldLinksPath, { force: true });
  }
}
