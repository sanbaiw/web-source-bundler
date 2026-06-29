import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  isLowSignalMarketingReference,
  shouldSkipReferenceBeforeFetch,
} from "../src/bundle-core/direct-references";
import type { ParsedPage } from "../src/bundle-core/types";
import { pngFigure } from "./helpers/assets";
import { runCli } from "./helpers/cli";
import { readReferenceManifest, referenceEntry } from "./helpers/manifest";
import { withAnyLoopbackServer, withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

function lowSignalMarketingPageFixture(): ParsedPage {
  return {
    url: "https://product.example/",
    title: "Product Example",
    html: "",
    mainHtml: `<main>
<section><h1>Build with AI</h1><p>Start for free and get started with our product.</p></section>
<section><h2>Trusted by leading teams</h2><p>Customers rely on this platform.</p></section>
<section><h2>Pricing that scales</h2><p>Choose Free, Pro, or Enterprise.</p></section>
<form><input name="email"><button>Sign up</button></form>
</main>`,
    articleHtml: "",
    directReferenceLinks: [],
    directReferences: [],
    allLinks: [],
    images: [],
  };
}

async function recursiveReaddirIfExists(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  return (await readdir(dir, { recursive: true })).map(String);
}

async function lowSignalMarketingReferencesAreSkippedAfterFetch(): Promise<void> {
  const figure = await pngFigure();

  await withAnyLoopbackServer(
    {
      "/main": {
        contentType: "text/html; charset=utf-8",
        body: (port) => `<!doctype html>
<html><head><title>Evaluation Notes</title></head>
<body><main><article>
<h1>Evaluation Notes</h1>
<p>Use the product homepage for provenance, but the docs and paper carry the actual evidence.</p>
<p><a href="https://0.0.0.0:${port}/">Bolt product homepage</a></p>
<p><a href="https://0.0.0.0:${port}/docs">Developer docs</a></p>
</article></main></body></html>`,
      },
      "/": {
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html><head><title>Bolt AI builder</title></head>
<body><main>
<section><h1>Build apps with AI</h1><p>Start for free and ship faster with our product.</p><a href="/signup">Get started</a></section>
<section><h2>Trusted by leading teams</h2><p>Customers love our platform.</p><img src="/customer-logo.png" alt="Customer logo"></section>
<section><h2>Pricing that scales</h2><p>Choose Free, Pro, or Enterprise.</p></section>
<section><h2>Join the newsletter</h2><form><input name="email"><button>Sign up</button></form></section>
</main></body></html>`,
      },
      "/docs": {
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html><head><title>Developer Docs</title></head>
<body><main><article>
<h1>Developer Docs</h1>
<p>Configure evaluations with deterministic grading and trace review.</p>
</article></main></body></html>`,
      },
      "/customer-logo.png": {
        contentType: "image/png",
        body: figure,
      },
    },
    async ({ sourceOrigin, referenceOrigin }) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const productUrl = `${referenceOrigin}/`;
        const docsUrl = `${referenceOrigin}/docs`;
        const result = await runCli([`${sourceOrigin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(
          index,
          new RegExp(
            `\\[Bolt product homepage\\]\\(${productUrl.replaceAll(".", "\\.")}\\)`,
          ),
        );
        assert.match(
          index,
          /\[Developer docs\]\(references\/developer-docs\.md\)/,
        );
        assert.match(
          index,
          /- \[Developer Docs\]\(references\/developer-docs\.md\)/,
        );
        assert.doesNotMatch(index, /- \[Bolt AI builder\]\(/);

        const referenceFiles = (
          await readdir(path.join(outDir, "references"))
        ).filter((file) => file.endsWith(".md"));
        assert.deepEqual(referenceFiles, ["developer-docs.md"]);

        const docs = await readFile(
          path.join(outDir, "references/developer-docs.md"),
          "utf8",
        );
        assert.match(docs, /Configure evaluations/);

        const manifest = await readReferenceManifest(outDir);
        assert.equal(
          referenceEntry(manifest, "references/developer-docs.md").original_url,
          docsUrl,
        );
        const skipped = manifest.skipped?.[productUrl];
        assert.ok(skipped);
        assert.equal(skipped.kind, "skipped");
        assert.equal(skipped.skipped_reason, "low_signal_marketing_reference");
        assert.equal(skipped.label, "Bolt product homepage");
        assert.equal(skipped.title, "Build apps with AI");

        const referenceAssets = await recursiveReaddirIfExists(
          path.join(outDir, "references/assets"),
        );
        assert.ok(
          !referenceAssets.some((file) => String(file).endsWith(".png")),
        );
      });
    },
  );
}

function knownProductHomepagesCanBeSkippedBeforeFetch(): void {
  const mainUrl = "https://research.example/articles/evals";
  const skippedUrls = [
    "https://bolt.new/",
    "https://anthropic.com/claude-code",
    "https://claude.com/product/claude-code",
    "https://claude.ai/code",
  ];

  for (const referenceUrl of skippedUrls) {
    assert.equal(
      shouldSkipReferenceBeforeFetch({ mainUrl, referenceUrl })?.skipped_reason,
      "low_signal_marketing_reference",
      referenceUrl,
    );
  }

  const preservedUrls = [
    "https://docs.bolt.new/getting-started",
    "https://braintrust.dev/docs/guides",
    "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
    "https://github.com/user/project",
    "https://example.org/",
  ];
  for (const referenceUrl of preservedUrls) {
    assert.equal(
      shouldSkipReferenceBeforeFetch({ mainUrl, referenceUrl }),
      null,
      referenceUrl,
    );
  }

  assert.equal(
    shouldSkipReferenceBeforeFetch({
      mainUrl: "https://bolt.new/",
      referenceUrl: "https://bolt.new/",
    }),
    null,
  );
}

function postFetchPolicyProtectsSourcesAndSkipsKnownLandingFinalUrls(): void {
  const mainUrl = "https://research.example/articles/evals";
  const page = lowSignalMarketingPageFixture();

  for (const subdomain of ["docs", "help", "developer", "developers", "api"]) {
    const referenceUrl = `https://${subdomain}.product.example/`;
    assert.equal(
      isLowSignalMarketingReference({ mainUrl, referenceUrl, page }),
      false,
      referenceUrl,
    );
  }

  assert.equal(
    shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://links.example/r/claude-code",
    }),
    null,
  );
  assert.equal(
    isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://anthropic.com/claude-code",
      page,
    }),
    true,
  );
  assert.equal(
    isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://claude.com/product/claude-code",
      page,
    }),
    true,
  );
  assert.equal(
    isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://claude.com/blog/using-claude-code",
      page,
    }),
    false,
  );
}

async function knownProductHomepageReferencesSkipBeforeNetworkFetch(): Promise<void> {
  const mainHtml = `<!doctype html>
<html><head><title>Main Source</title></head>
<body><main><article>
<h1>Main Source</h1>
<p><a href="https://bolt.new/">Bolt homepage</a></p>
<p><a href="/docs">Local docs</a></p>
</article></main></body></html>`;
  const docsHtml = `<!doctype html>
<html><head><title>Local Docs</title></head>
<body><main><article><h1>Local Docs</h1><p>Implementation details.</p></article></main></body></html>`;

  await withServer(
    {
      "/main": { contentType: "text/html; charset=utf-8", body: mainHtml },
      "/docs": { contentType: "text/html; charset=utf-8", body: docsHtml },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);
        assert.match(
          result.stderr,
          /Skipping low-signal reference https:\/\/bolt\.new\//,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /\[Bolt homepage\]\(https:\/\/bolt\.new\/\)/);
        assert.match(index, /\[Local docs\]\(references\/local-docs\.md\)/);
        assert.doesNotMatch(index, /- \[Bolt homepage\]\(/);
        assert.match(index, /- \[Local Docs\]\(references\/local-docs\.md\)/);

        const manifest = await readReferenceManifest(outDir);
        assert.equal(
          referenceEntry(manifest, "references/local-docs.md").original_url,
          `${origin}/docs`,
        );
        const skipped = manifest.skipped?.["https://bolt.new/"];
        assert.ok(skipped);
        assert.equal(skipped.label, "Bolt homepage");
        assert.equal("title" in skipped, false);
        assert.equal("content_type" in skipped, false);
      });
    },
  );
}

async function articleProseWithMarketingTermsStillBundles(): Promise<void> {
  await withAnyLoopbackServer(
    {
      "/main": {
        contentType: "text/html; charset=utf-8",
        body: (port) => `<!doctype html>
<html><head><title>Main Source</title></head>
<body><main><article>
<h1>Main Source</h1>
<p><a href="https://0.0.0.0:${port}/analysis">Market analysis</a></p>
</article></main></body></html>`,
      },
      "/analysis": {
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html><head><title>Market analysis</title></head>
<body><main><article>
<h1>Market analysis</h1>
<p>The article compares pricing, customers, testimonials, and product positioning as evidence in a broader evaluation.</p>
<p>It does not ask readers to sign up, buy a plan, or join a newsletter.</p>
</article></main></body></html>`,
      },
    },
    async ({ sourceOrigin, referenceOrigin }) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${sourceOrigin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(
          index,
          /\[Market analysis\]\(references\/market-analysis\.md\)/,
        );
        const reference = await readFile(
          path.join(outDir, "references/market-analysis.md"),
          "utf8",
        );
        assert.match(reference, /compares pricing, customers, testimonials/);

        const manifest = await readReferenceManifest(outDir);
        assert.equal(
          referenceEntry(manifest, "references/market-analysis.md")
            .original_url,
          `${referenceOrigin}/analysis`,
        );
        assert.equal(manifest.skipped, undefined);
      });
    },
  );
}

export const marketingReferencesSuite: TestSuite = {
  name: "marketing references",
  tests: [
    {
      name: "low-signal marketing references are skipped after fetch",
      run: lowSignalMarketingReferencesAreSkippedAfterFetch,
    },
    {
      name: "known product homepages can be skipped before fetch",
      run: knownProductHomepagesCanBeSkippedBeforeFetch,
    },
    {
      name: "post-fetch policy protects sources and skips known landing finals",
      run: postFetchPolicyProtectsSourcesAndSkipsKnownLandingFinalUrls,
    },
    {
      name: "known product homepage references skip before network fetch",
      run: knownProductHomepageReferencesSkipBeforeNetworkFetch,
    },
    {
      name: "article prose with marketing terms still bundles",
      run: articleProseWithMarketingTermsStillBundles,
    },
  ],
};
