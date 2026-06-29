import * as assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { runCli } from "./helpers/cli";
import { readReferenceManifest, referenceEntry } from "./helpers/manifest";
import { withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

async function directReferencesOnlyRenderOnMainPage(): Promise<void> {
  const refHtml = `<!doctype html><html><head><title>Reference One</title></head>
<body><main><article><h1>Reference One</h1><p>ref body</p>
<a href="https://ext-a.example.com/x">external a</a>
<a href="https://ext-b.example.com/y">external b</a>
</article></main></body></html>`;
  const mainHtml = (
    port: number,
  ) => `<!doctype html><html><head><title>Main Source</title></head>
<body><main><article><h1>Main Source</h1><p>intro</p>
<a href="https://127.0.0.1:${port}/ref">Reference One</a>
</article></main></body></html>`;

  await withServer(
    {
      "/main": { contentType: "text/html; charset=utf-8", body: mainHtml },
      "/ref": { contentType: "text/html; charset=utf-8", body: refHtml },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /## Direct References/);

        const refFiles = (
          await readdir(path.join(outDir, "references"))
        ).filter((file) => file.endsWith(".md"));
        const refIndex = await readFile(
          path.join(outDir, "references", refFiles[0] ?? ""),
          "utf8",
        );
        assert.doesNotMatch(refIndex, /## Direct References/);
      });
    },
  );
}

async function fragmentAndDocumentUrlsShareOneReferencePage(): Promise<void> {
  const mainHtml = `<!doctype html><html><head><title>Main Source</title></head>
<body><main><article>
<h1>Main Source</h1>
<p><a href="/reference#section">Reference section</a></p>
<p><a href="/reference">Reference root</a></p>
</article></main></body></html>`;
  const refHtml = `<!doctype html><html><head><title>Reference Doc</title></head>
<body><main><article><h1>Reference Doc</h1><p>reference body</p></article></main></body></html>`;

  await withServer(
    {
      "/main": {
        contentType: "text/html; charset=utf-8",
        body: mainHtml,
      },
      "/reference": {
        contentType: "text/html; charset=utf-8",
        body: refHtml,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
          (result.stderr.match(/Fetching reference source/g) || []).length,
          1,
        );

        const referenceFiles = (
          await readdir(path.join(outDir, "references"))
        ).filter((file) => file.endsWith(".md"));
        assert.deepEqual(referenceFiles, ["reference-doc.md"]);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const directReferenceLines = index
          .split("\n")
          .filter(
            (line) => line === "- [Reference Doc](references/reference-doc.md)",
          );
        assert.equal(directReferenceLines.length, 1);
        assert.match(
          index,
          /\[Reference section\]\(references\/reference-doc\.md\)/,
        );
        assert.match(
          index,
          /\[Reference root\]\(references\/reference-doc\.md\)/,
        );
        assert.doesNotMatch(index, /reference-doc-2\.md/);

        const manifest = await readReferenceManifest(outDir);
        assert.equal(
          referenceEntry(manifest, "references/reference-doc.md").original_url,
          `${origin}/reference#section`,
        );
        assert.equal(manifest["references/reference-doc-2.md"], undefined);
      });
    },
  );
}

async function unresolvedRelativeLinksAreAbsolutized(): Promise<void> {
  const refHtml = `<!doctype html>
<html><head><title>Reference One</title></head>
<body><main><article>
<h1>Reference One</h1>
<p><a href="/docs/getting-started">Docs</a></p>
</article></main></body></html>`;
  const mainHtml = (
    port: number,
  ) => `<!doctype html><html><head><title>Main Source</title></head>
<body><main><article>
<h1>Main Source</h1>
<p><a href="https://127.0.0.1:${port}/ref">Reference One</a></p>
</article></main></body></html>`;

  await withServer(
    {
      "/main": { contentType: "text/html; charset=utf-8", body: mainHtml },
      "/ref": { contentType: "text/html; charset=utf-8", body: refHtml },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/main`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const { port } = new URL(origin);
        const refFiles = (
          await readdir(path.join(outDir, "references"))
        ).filter((file) => file.endsWith(".md"));
        const refIndex = await readFile(
          path.join(outDir, "references", refFiles[0] ?? ""),
          "utf8",
        );
        assert.match(
          refIndex,
          new RegExp(
            `\\[Docs\\]\\(https://127\\.0\\.0\\.1:${port}/docs/getting-started\\)`,
          ),
        );
        assert.doesNotMatch(refIndex, /\[Docs\]\(\/docs\/getting-started\)/);
      });
    },
  );
}

async function structuralChromeLinksAreNotBundledAsReferences(): Promise<void> {
  const mainHtml = `<!doctype html>
<html><head><title>Product Page</title></head>
<body>
<header>
  <nav>
    <a href="/pricing">Pricing</a>
    <a href="/careers">Careers</a>
  </nav>
</header>
<div>
  <h1>Product Page</h1>
  <p>Use the product with the <a href="/docs">developer docs</a>.</p>
</div>
<footer><a href="/terms">Terms</a></footer>
</body></html>`;
  const simplePage = (
    title: string,
  ) => `<!doctype html><html><head><title>${title}</title></head>
<body><main><article><h1>${title}</h1><p>${title} body.</p></article></main></body></html>`;

  await withServer(
    {
      "/product": { contentType: "text/html; charset=utf-8", body: mainHtml },
      "/pricing": {
        contentType: "text/html; charset=utf-8",
        body: simplePage("Pricing"),
      },
      "/careers": {
        contentType: "text/html; charset=utf-8",
        body: simplePage("Careers"),
      },
      "/docs": {
        contentType: "text/html; charset=utf-8",
        body: simplePage("Developer Docs"),
      },
      "/terms": {
        contentType: "text/html; charset=utf-8",
        body: simplePage("Terms"),
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/product`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(
          index,
          /\[developer docs\]\(references\/developer-docs\.md\)/,
        );
        assert.doesNotMatch(index, /Pricing|Terms/);

        const manifest = await readReferenceManifest(outDir);
        const originalUrls = Object.keys(manifest)
          .filter((key) => key !== "skipped")
          .map((key) => referenceEntry(manifest, key).original_url);
        assert.deepEqual(originalUrls, [`${origin}/docs`]);
      });
    },
  );
}

export const directReferencesSuite: TestSuite = {
  name: "direct references",
  tests: [
    {
      name: "Direct References render only on the main page",
      run: directReferencesOnlyRenderOnMainPage,
    },
    {
      name: "fragment and document URLs share one reference page",
      run: fragmentAndDocumentUrlsShareOneReferencePage,
    },
    {
      name: "unresolved relative links are absolutized",
      run: unresolvedRelativeLinksAreAbsolutized,
    },
    {
      name: "structural chrome links are not bundled as references",
      run: structuralChromeLinksAreNotBundledAsReferences,
    },
  ],
};
