import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "./helpers/cli";
import { withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

async function markdownResponsesRemainReadableSourceEntries(): Promise<void> {
  const markdownBody = "# Preserved Markdown\n\n- alpha\n- beta\n";

  await withServer(
    {
      "/source.md": {
        contentType: "text/markdown; charset=utf-8",
        body: markdownBody,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/source.md`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /Source: https:\/\/127\.0\.0\.1:/);
        assert.match(index, /Content-Type: text\/markdown; charset=utf-8/);
        assert.match(index, /- alpha\n- beta/);
        assert.doesNotMatch(index, /```markdown/);
        assert.equal((index.match(/^# /gm) || []).length, 1);
      });
    },
  );
}

async function jsonResponsesRemainExactInsideFence(): Promise<void> {
  const jsonBody = '{"b":2,\n  "a":1}\n';

  await withServer(
    {
      "/data.json": {
        contentType: "application/json; charset=utf-8",
        body: jsonBody,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/data.json`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, /Content-Type: application\/json; charset=utf-8/);
        assert.ok(index.includes(`\`\`\`json\n${jsonBody}\`\`\``));
        assert.doesNotMatch(index, /"a": 1,\n {2}"b": 2/);
      });
    },
  );
}

async function binaryResponsesCreateSourceAssetStub(): Promise<void> {
  const pdfBody = Buffer.from("%PDF-1.7\nbinary\u0000payload\n", "utf8");

  await withServer(
    {
      "/paper.pdf": {
        contentType: "application/pdf",
        body: pdfBody,
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/paper.pdf`, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const asset = await readFile(path.join(outDir, "assets/source.pdf"));
        assert.match(
          index,
          /Original source asset: \[assets\/source\.pdf\]\(assets\/source\.pdf\)/,
        );
        assert.match(index, /Text extraction is deferred/);
        assert.equal(Buffer.compare(asset, pdfBody), 0);
      });
    },
  );
}

async function redirectProvenanceRecordsAllUrls(): Promise<void> {
  await withServer(
    {
      "/redirect": {
        status: 302,
        redirect: "/target.md",
      },
      "/target.md": {
        contentType: "text/markdown; charset=utf-8",
        body: "# Redirect Target\n",
      },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const requested = `${origin.replace("https:", "http:")}/redirect`;
        const fetched = `${origin}/redirect`;
        const final = `${origin}/target.md`;
        const result = await runCli([requested, outDir]);
        assert.equal(result.code, 0, result.stderr);

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert.match(index, new RegExp(`Source: ${requested}`));
        assert.match(index, new RegExp(`Fetched URL: ${fetched}`));
        assert.match(index, new RegExp(`Final URL: ${final}`));
      });
    },
  );
}

export const sourcePreservationSuite: TestSuite = {
  name: "source preservation",
  tests: [
    {
      name: "markdown responses remain readable source entries",
      run: markdownResponsesRemainReadableSourceEntries,
    },
    {
      name: "JSON responses remain exact inside a fenced block",
      run: jsonResponsesRemainExactInsideFence,
    },
    {
      name: "binary responses create a source asset stub",
      run: binaryResponsesCreateSourceAssetStub,
    },
    {
      name: "redirect provenance records requested, fetched, and final URLs",
      run: redirectProvenanceRecordsAllUrls,
    },
  ],
};
