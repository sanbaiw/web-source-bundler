import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { tidyConvertedMarkdown } from "../src/bundle-core/rendering";
import { PNG_PIXEL } from "./helpers/assets";
import { runCli } from "./helpers/cli";
import { withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

async function tablesWithListCellsConvertToSingleLineRows(): Promise<void> {
  const htmlBody = `<!doctype html>
<html><head><title>Graders</title></head>
<body><main><article>
<h1>Graders</h1>
<table>
<thead><tr><th>Methods</th><th>Strengths</th></tr></thead>
<tbody><tr>
<td><ul><li>String match</li><li>Binary tests</li></ul></td>
<td><ul><li>Fast</li><li>Cheap</li></ul></td>
</tr></tbody>
</table>
</article></main></body></html>`;

  await withServer(
    { "/graders": { contentType: "text/html; charset=utf-8", body: htmlBody } },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/graders`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const tableRows = index
          .split("\n")
          .filter((line) => line.trim().startsWith("|"));
        assert.equal(tableRows.length, 3);
        assert.match(tableRows[2] ?? "", /String match<br>Binary tests/);
        assert.match(tableRows[2] ?? "", /Fast<br>Cheap/);
      });
    },
  );
}

async function duplicateTitleHeadingIsDeduplicatedAfterLongChrome(): Promise<void> {
  const htmlBody = `<!doctype html>
<html><head>
<title>Long chrome</title>
<meta property="og:title" content="Long Chrome Title">
</head>
<body><main>
<div>${"x".repeat(2500)}</div>
<article>
<h1>Long chrome</h1>
<p>Body text after a long preamble.</p>
</article>
</main></body></html>`;

  await withServer(
    {
      "/long-post": { contentType: "text/html; charset=utf-8", body: htmlBody },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/long-post`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.equal((index.match(/^# /gm) || []).length, 1);
        assert.match(index, /Body text after a long preamble\./);
      });
    },
  );
}

async function markdownPassthroughStripsPreambleAndMdxComponents(): Promise<void> {
  const markdownBody = [
    "> ## Documentation Index",
    "> Fetch the complete documentation index at: https://example.com/llms.txt",
    "",
    "# Agent SDK overview",
    "",
    "<CodeGroup>",
    "",
    "```python Python theme={null}",
    "print('hi')",
    "```",
    "",
    "</CodeGroup>",
    "",
    "<Note>Remember this.</Note>",
    "",
    "Real documentation prose.",
    "",
  ].join("\n");

  await withServer(
    {
      "/overview.md": {
        contentType: "text/markdown; charset=utf-8",
        body: markdownBody,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/overview.md`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.equal((index.match(/^# /gm) || []).length, 1);
        assert.doesNotMatch(index, /Documentation Index|<CodeGroup>|<Note>/);
        assert.doesNotMatch(index, /theme=\{null\}/);
        assert.match(index, /print\('hi'\)/);
        assert.match(index, /Remember this\./);
        assert.match(index, /Real documentation prose\./);
      });
    },
  );
}

async function emptyTextLinksAndSelfLinksAreCleaned(): Promise<void> {
  const htmlBody = `<!doctype html>
<html><head><title>Links</title></head>
<body><main><article>
<h1>Links</h1>
<p>Edit button: <a href="https://example.com/edit"><img src="/i.png" alt="icon"></a> here.</p>
<p>Body paragraph with no links.</p>
</article></main></body></html>`;

  await withServer(
    {
      "/self": { contentType: "text/html; charset=utf-8", body: htmlBody },
      "/i.png": { contentType: "image/png", body: PNG_PIXEL },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/self`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.doesNotMatch(index, /\[\s*\]\(/);
        assert.match(index, /Edit button: here\./);
      });
    },
  );

  assert.match(
    tidyConvertedMarkdown(
      "See [tau2-bench paper](tau2-bench.md) and [other](https://x.example/y).",
      "tau2-bench.md",
    ),
    /See tau2-bench paper and \[other\]\(https:\/\/x\.example\/y\)\./,
  );
  assert.equal(
    tidyConvertedMarkdown('[](https://a.example "title")[](https://b.example)'),
    "",
  );
}

export const renderingSuite: TestSuite = {
  name: "rendering",
  tests: [
    {
      name: "tables with list cells convert to single-line rows",
      run: tablesWithListCellsConvertToSingleLineRows,
    },
    {
      name: "duplicate title heading is deduplicated after long chrome",
      run: duplicateTitleHeadingIsDeduplicatedAfterLongChrome,
    },
    {
      name: "Markdown passthrough strips llms preamble and MDX wrappers",
      run: markdownPassthroughStripsPreambleAndMdxComponents,
    },
    {
      name: "empty text links and self links are cleaned",
      run: emptyTextLinksAndSelfLinksAreCleaned,
    },
  ],
};
