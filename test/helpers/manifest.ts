import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ReferenceManifestEntry,
  SkippedReferenceManifestEntry,
} from "../../src/bundle-core/types";

interface ReferenceManifest {
  skipped?: Record<string, SkippedReferenceManifestEntry>;
  [path: string]: unknown;
}

export async function readReferenceManifest(
  outDir: string,
): Promise<ReferenceManifest> {
  return JSON.parse(
    await readFile(path.join(outDir, "references", "references.json"), "utf8"),
  ) as ReferenceManifest;
}

export function referenceEntry(
  manifest: ReferenceManifest,
  relativePath: string,
): ReferenceManifestEntry {
  const entry = manifest[relativePath];
  if (!isReferenceManifestEntry(entry)) {
    throw new Error(`Expected manifest entry for ${relativePath}`);
  }
  return entry;
}

function isReferenceManifestEntry(
  value: unknown,
): value is ReferenceManifestEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("original_url" in value) || !("kind" in value)) {
    return false;
  }
  const kind = (value as { kind: unknown }).kind;
  return ["html", "text", "asset", "failed"].includes(String(kind));
}
