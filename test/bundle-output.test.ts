import * as assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PNG_PIXEL, pngFigure } from "./helpers/assets";
import { runCli } from "./helpers/cli";
import { readReferenceManifest, referenceEntry } from "./helpers/manifest";
import { withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

async function htmlPagesConvertAndBinaryReferencesArePreserved(): Promise<void> {
  const pdfBody = Buffer.from("%PDF-1.7\nreference-payload\n", "utf8");
  const figure = await pngFigure();
  const htmlBody = `<!doctype html>
<html>
  <head><title>Article</title></head>
  <body>
    <main>
      <article>
        <h1>Article</h1>
        <p>Intro paragraph.</p>
        <table><tr><th>Name</th></tr><tr><td>Ada</td></tr></table>
        <img src="/diagram.png" alt="Diagram">
        <p><a href="/paper-redirect">Paper PDF</a></p>
      </article>
    </main>
  </body>
</html>`;

  await withServer(
    {
      "/article": {
        contentType: "text/html; charset=utf-8",
        body: htmlBody,
      },
      "/diagram.png": {
        contentType: "image/png",
        body: figure,
      },
      "/paper-redirect": {
        status: 302,
        redirect: "/paper.pdf",
      },
      "/paper.pdf": {
        contentType: "application/pdf",
        body: pdfBody,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/article`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /Intro paragraph\./);
        assert.match(index, /\| Name \|/);
        assert.match(index, /!\[Diagram\]\(assets\/01-diagram\.png\)/);
        assert.match(index, /\[paper\.pdf\]\(references\/paper-pdf\.md\)/);

        const localizedImage = await readFile(
          path.join(outDir, "assets/01-diagram.png"),
        );
        assert.equal(Buffer.compare(localizedImage, figure), 0);

        const referenceStub = await readFile(
          path.join(outDir, "references/paper-pdf.md"),
          "utf8",
        );
        assert.match(
          referenceStub,
          /Original source asset: \[assets\/paper-pdf\.pdf\]\(assets\/paper-pdf\.pdf\)/,
        );
        const referenceAsset = await readFile(
          path.join(outDir, "references/assets/paper-pdf.pdf"),
        );
        assert.equal(Buffer.compare(referenceAsset, pdfBody), 0);

        const manifest = await readReferenceManifest(outDir);
        const paper = referenceEntry(manifest, "references/paper-pdf.md");
        assert.equal(paper.original_url, `${origin}/paper-redirect`);
        assert.equal(paper.final_url, `${origin}/paper.pdf`);
        assert.equal(paper.content_type, "application/pdf");
        assert.equal(paper.kind, "asset");
        assert.equal(paper.asset_path, "references/assets/paper-pdf.pdf");
      });
    },
  );
}

async function junkAssetsAreFilteredAndRealFiguresKept(): Promise<void> {
  const figure = await pngFigure();
  const htmlErrorAsGif =
    "<!DOCTYPE html><html><title>Wikimedia Error</title><body>rate limited</body></html>";
  const htmlBody = `<!doctype html>
<html><head><title>Figures</title></head>
<body><main><article>
<h1>Figures</h1>
<p>Context paragraph.</p>
<img src="/track.png" alt="tracking">
<img src="/broken.gif" alt="animation">
<img src="/figure.png" alt="real figure">
</article></main></body></html>`;

  await withServer(
    {
      "/page": { contentType: "text/html; charset=utf-8", body: htmlBody },
      "/track.png": { contentType: "image/png", body: PNG_PIXEL },
      "/broken.gif": { contentType: "image/gif", body: htmlErrorAsGif },
      "/figure.png": { contentType: "image/png", body: figure },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/page`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const assetFiles = await readdir(path.join(outDir, "assets"));
        assert.deepEqual(assetFiles, ["01-real-figure.png"]);
        assert.match(index, /!\[real figure\]\(assets\/01-real-figure\.png\)/);
        assert.doesNotMatch(index, /track|animation/);
        assert.match(index, /Context paragraph\./);
      });
    },
  );
}

async function emptyAltImagesRemainValidMarkdownImages(): Promise<void> {
  const figure = await pngFigure();
  const htmlBody = `<!doctype html>
<html><head><title>Hero</title></head>
<body><main><article>
<h1>Hero</h1>
<img src="/hero.png" alt="">
</article></main></body></html>`;

  await withServer(
    {
      "/hero": { contentType: "text/html; charset=utf-8", body: htmlBody },
      "/hero.png": { contentType: "image/png", body: figure },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/hero`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /!\[\]\(assets\/01-hero\.png\)/);
        assert.ok(!index.split("\n").includes("!"));
      });
    },
  );
}

export const bundleOutputSuite: TestSuite = {
  name: "bundle output",
  tests: [
    {
      name: "HTML pages convert and binary references are preserved",
      run: htmlPagesConvertAndBinaryReferencesArePreserved,
    },
    {
      name: "junk assets are filtered and real figures are kept",
      run: junkAssetsAreFilteredAndRealFiguresKept,
    },
    {
      name: "empty-alt images remain valid Markdown images",
      run: emptyAltImagesRemainValidMarkdownImages,
    },
  ],
};
