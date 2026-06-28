import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLowSignalMarketingReference,
  shouldSkipReferenceBeforeFetch,
} from "../src/bundle-core/direct-references.ts";
import {
  applySiteRules,
  stripGenericChrome,
} from "../src/bundle-core/page-extraction.ts";
import { tidyConvertedMarkdown } from "../src/bundle-core/rendering.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.resolve(repoRoot, "dist/cli.js");
const nodePath =
  process.env.WEB_SOURCE_BUNDLER_TEST_NODE ||
  (process.env.NVM_BIN ? path.join(process.env.NVM_BIN, "node") : "node");
const cliEnv = {
  ...process.env,
  PATH: process.env.NVM_BIN
    ? `${process.env.NVM_BIN}:${process.env.PATH}`
    : process.env.PATH,
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
};

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIURXuOb5CqY9mS0iUdVwAQd5wA8KEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDYxNzE2Mzk1OFoYDzIxMjYw
NTI0MTYzOTU4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCjS8wAW2TNJgZSboKRpJG2CGRbKIikv+bUlj4LiDNw
zXHwcNpkyYjV9uyQBtziViyyTeQE6wo3YnxAdh5NcTD8fT84Oq/i0KhQhtRxYlxf
5iNaiXl3wz/Sykwo3IRlScf/4zpBks3RVpon9sYTlG4sbdqot4ZfzRV+8bsfBQuX
vhQ440dDtuDaPIdD90bLF/iWjOSJ+EFLPqjTH1vmeG81nZSwIby4PF1OoDrV1Mze
gWol2UKSOQV6JijbVBC0cTkK/4PkK6MbO9+c/zwUykIb2+i7lG9BAB4wIKoNCuML
VTsRmJXi/oqlJ06P3zyx9Lq++56ny8ErEOLn2MUqSJH5AgMBAAGjZDBiMB0GA1Ud
DgQWBBSrHmphijx31dyyqpUNbTokmaXULTAfBgNVHSMEGDAWgBSrHmphijx31dyy
qpUNbTokmaXULTAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAJ+kEMmQI1+ljvHzJ4j2d790xi02dAHxtjaZiDFJdHPi
wPfHhibgt7QuCQO3fV63xRGWQ0QullhkCOiaZhueGb+I9Ey+dGdYumXuua4XQpS+
XAChQzukIJftLqakM6Cy+FRqWEZFwne+T3eiq4/0vL/uEC3AfCOLahuj7hCE7ocF
8BfJW8NjpOYlcG2xQL9YbtepQKo4C73xybO5ehNE/38lc8mxCb9Z+XMTZR/rwhvs
rK2CUfHfNtDhsDtNYkHutJ0p0D2Mm8awkQYz9NSWRy6GON83UQPPWcF5/Emy1QDe
03xvBkdMagQiHw5+R9s79EWVtQamPcOsPtEQ5JR+J8k=
-----END CERTIFICATE-----`;

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCjS8wAW2TNJgZS
boKRpJG2CGRbKIikv+bUlj4LiDNwzXHwcNpkyYjV9uyQBtziViyyTeQE6wo3YnxA
dh5NcTD8fT84Oq/i0KhQhtRxYlxf5iNaiXl3wz/Sykwo3IRlScf/4zpBks3RVpon
9sYTlG4sbdqot4ZfzRV+8bsfBQuXvhQ440dDtuDaPIdD90bLF/iWjOSJ+EFLPqjT
H1vmeG81nZSwIby4PF1OoDrV1MzegWol2UKSOQV6JijbVBC0cTkK/4PkK6MbO9+c
/zwUykIb2+i7lG9BAB4wIKoNCuMLVTsRmJXi/oqlJ06P3zyx9Lq++56ny8ErEOLn
2MUqSJH5AgMBAAECggEAOui8swJFhpapoDI6y0TVxhgX8CTayqhqIxYCUxGzEQYk
jQuBVeu4gAvgwoKfS82vuTFNSZLrMBjI305dVy228NdUJ7pQOmBw4AAMAs1rqrLw
3RgMKG7ZBvew6urGnm20B3WXThGiS1tVKIanZWfeKQwGXmg6wzPOhem5yhJ9YKN/
GQNuX5q4Ouim2O2CS6XPrSWEXcxgK+XwrzB9c2vfeF9itpHjZv9jqRHupmQNLmRD
iHoUGQ73vOX5KR/wtEs9Fir75wQMviLw/BFT7S6CrJAD//g4VZzoiSKPL/7LvejV
7u7GfI4hg/XDiYYwSy28xePl7MYet8jYSbkk14cYgwKBgQDhehuFrk9kRH6Apyrm
l+wuhumDrvEvpqxwlFtmM2ZMFwAV7SSMfywZZr9a1id0rPmmnZe+fq4/VbaJzFrq
uBOkMO/+EzYrWIBhy8UDv5g7d2CC4dKq3kiydIWslD/XAggj7E923vGdKuFDvknW
RZsSFTUGJDScVIhVz/zqBN7kVwKBgQC5ZtBLlea9Fe+OOJImxEZ+MglZujSYa8AQ
e8d0pyEoH/cA6KcpGW6R1GG1hcd6HNgXgYDkIpTXPbpUA6bJkQ+konKN8VA1bpd8
uTwVICZhzWNTndJfua25CH0CagpNJ0hs3iCgHpEgG7GbczRk9oD5xidr3lVoTt0j
bCOTBlDKLwKBgCuTp+IMMDfWrQQ8SqRKVFEhrdvPYbmt4sHXSlrUMD8gatnR/TBS
G7nFC9KIdROtooo7BurAHPkMnbzADAo1DUa8VoWqPNvfvOApu6ffzZIgnjxtXIO9
dhtXPcZ+2F+7estGjo0QxW10rhijnC2XQkMaaicHtEtKYxcCnYS08Eb9AoGAG5Rc
xfGtmlEqCpkFvLiT1+/vjiZx7n6Q2qLfH85A02w13S++thFvbkgOpOcarmKeDpkY
KFewlng7QIYuiGuIzS/RJKZSDTC/XjFb67SVoRThgq3GfrDrU8wcdIB7udBvKKq+
ZbNGWWVlPT+c+qvkscM1WAmB4PtiUAOlIxjcaccCgYEAyBvTEGBqkZuNuFlYfP/f
pxR6wsprWu7YFD+5Uz0Vv/LiRGo+gKV9MS2MmXoZj8iTV1eXQaT177aMp96AJ2gy
UfSLp2SpCSyLt6dZnsqHtbwjxtSbnTersDJzVISipijoD268u9bw0b48+zVZc0BR
Riu1Sv8wC1+nvt8auYC9x/s=
-----END PRIVATE KEY-----`;

const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

// A realistic 120x90 incompressible PNG (~3.9 KB) that clears the asset-hygiene
// floors (>=512 bytes, both dimensions above the favicon/badge thresholds), so it
// stands in for a genuine article figure rather than a tracking pixel.
const PNG_FIGURE = Buffer.from(
  "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",
  "base64",
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      nodePath,
      [cliPath, ...args],
      {
        cwd: repoRoot,
        env: cliEnv,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function runExecutable(executable, args) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd: repoRoot,
        env: cliEnv,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function withServer(routes, fn) {
  const server = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const route = routes[req.url || "/"];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (route.redirect) {
      res.writeHead(route.status || 302, { location: route.redirect });
      res.end();
      return;
    }

    const body =
      typeof route.body === "function"
        ? route.body(server.address().port)
        : route.body;
    res.writeHead(route.status || 200, { "content-type": route.contentType });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await fn(`https://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withAnyLoopbackServer(routes, fn) {
  const server = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const route = routes[req.url || "/"];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const body =
      typeof route.body === "function"
        ? route.body(server.address().port)
        : route.body;
    res.writeHead(route.status || 200, { "content-type": route.contentType });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const { port } = server.address();

  try {
    await fn({
      sourceOrigin: `https://127.0.0.1:${port}`,
      referenceOrigin: `https://0.0.0.0:${port}`,
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "web-source-bundler-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testMarkdownResponsesRemainReadableSourceEntries() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("Source: https://127.0.0.1:"),
          "expected source provenance header",
        );
        assert(
          index.includes("Content-Type: text/markdown; charset=utf-8"),
          "expected content type provenance",
        );
        // The body content is preserved, but the redundant leading H1 (which the
        // provenance header already emits as `# {title}`) is de-duplicated.
        assert(
          index.includes("- alpha\n- beta"),
          "expected original Markdown body content to be preserved",
        );
        assert(
          !index.includes("```markdown"),
          "expected Markdown body not to be fenced",
        );
        const h1Count = (index.match(/^# /gm) || []).length;
        assert(
          h1Count === 1,
          `expected exactly one H1 after dedup, got ${h1Count}`,
        );
      });
    },
  );
}

async function testPackagedBinSymlinkRunsCliEntrypoint() {
  await withTempDir(async (dir) => {
    const binPath = path.join(dir, "web-source-bundler");
    await symlink(cliPath, binPath);

    const result = await runExecutable(binPath, ["--help"]);
    assert(
      result.code === 0,
      `expected symlinked bin help to succeed, got ${result.code}: ${result.stderr}`,
    );
    assert(
      result.stdout.includes("web-source-bundler [options] <url> <output-dir>"),
      "expected symlinked bin to print CLI usage",
    );

    const versionResult = await runExecutable(binPath, ["--version"]);
    assert(
      versionResult.code === 0,
      `expected symlinked bin version to succeed, got ${versionResult.code}: ${versionResult.stderr}`,
    );
    assert(
      versionResult.stdout.trim() === "0.1.0",
      "expected symlinked bin to print package version",
    );
  });
}

async function testJsonResponsesRemainUnformattedInsideFence() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("Content-Type: application/json; charset=utf-8"),
          "expected JSON content type provenance",
        );
        assert(
          index.includes(`\`\`\`json\n${jsonBody}\`\`\``),
          "expected exact JSON body inside a json fence",
        );
        assert(
          !index.includes('"a": 1,\n  "b": 2'),
          "expected JSON not to be pretty-printed or reordered",
        );
      });
    },
  );
}

async function testBinaryResponsesCreateSourceAssetStub() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const asset = await readFile(path.join(outDir, "assets/source.pdf"));
        assert(
          index.includes(
            "Original source asset: [assets/source.pdf](assets/source.pdf)",
          ),
          "expected stub to link source asset",
        );
        assert(
          index.includes(
            "Text extraction is deferred to a specialized pipeline.",
          ),
          "expected deferred extraction stub",
        );
        assert(
          Buffer.compare(asset, pdfBody) === 0,
          "expected source asset bytes to match response exactly",
        );
      });
    },
  );
}

async function testRedirectProvenanceRecordsRequestedFetchedAndFinalUrls() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes(`Source: ${requested}`),
          "expected original requested URL provenance",
        );
        assert(
          index.includes(`Fetched URL: ${fetched}`),
          "expected HTTP-to-HTTPS fetched URL provenance",
        );
        assert(
          index.includes(`Final URL: ${final}`),
          "expected redirect final URL provenance",
        );
      });
    },
  );
}

async function testInvalidUrlsFailBeforeFetchWithClearErrors() {
  await withTempDir(async (dir) => {
    const dotlessResult = await runCli([
      "https://localhost/source.md",
      path.join(dir, "dotless"),
    ]);
    assert(dotlessResult.code !== 0, "expected dotless hostname to fail");
    assert(
      dotlessResult.stderr.includes("hostname must contain a dot"),
      "expected dotless hostname error",
    );

    const credentialResult = await runCli([
      "https://user:pass@127.0.0.1/source.md",
      path.join(dir, "credentials"),
    ]);
    assert(credentialResult.code !== 0, "expected credential URL to fail");
    assert(
      credentialResult.stderr.includes("username and password are not allowed"),
      "expected credential URL error",
    );
  });
}

async function testHtmlPagesStillConvertAndBinaryReferencesArePreserved() {
  const pdfBody = Buffer.from("%PDF-1.7\nreference-payload\n", "utf8");
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
        body: PNG_FIGURE,
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("Intro paragraph."),
          "expected HTML body to convert to Markdown",
        );
        assert(
          index.includes("| Name |"),
          "expected GFM table conversion to remain enabled",
        );
        assert(
          index.includes("![Diagram](assets/01-diagram.png)"),
          "expected page image to be localized",
        );
        assert(
          index.includes("[paper.pdf](references/paper-pdf.md)"),
          "expected direct reference link to point local",
        );

        const localizedImage = await readFile(
          path.join(outDir, "assets/01-diagram.png"),
        );
        assert(
          Buffer.compare(localizedImage, PNG_FIGURE) === 0,
          "expected localized image bytes to match",
        );

        const referenceStub = await readFile(
          path.join(outDir, "references/paper-pdf.md"),
          "utf8",
        );
        assert(
          referenceStub.includes(
            "Original source asset: [assets/paper-pdf.pdf](assets/paper-pdf.pdf)",
          ),
          "expected binary reference stub to link preserved asset",
        );
        const referenceAsset = await readFile(
          path.join(outDir, "references/assets/paper-pdf.pdf"),
        );
        assert(
          Buffer.compare(referenceAsset, pdfBody) === 0,
          "expected binary reference asset bytes to match",
        );

        const manifest = JSON.parse(
          await readFile(
            path.join(outDir, "references/references.json"),
            "utf8",
          ),
        );
        assert(
          manifest["references/paper-pdf.md"].original_url ===
            `${origin}/paper-redirect`,
          "expected manifest original URL",
        );
        assert(
          manifest["references/paper-pdf.md"].final_url ===
            `${origin}/paper.pdf`,
          "expected manifest final URL",
        );
        assert(
          manifest["references/paper-pdf.md"].content_type ===
            "application/pdf",
          "expected manifest content type",
        );
        assert(
          manifest["references/paper-pdf.md"].kind === "asset",
          "expected manifest asset kind",
        );
        assert(
          manifest["references/paper-pdf.md"].asset_path ===
            "references/assets/paper-pdf.pdf",
          "expected manifest asset path",
        );
      });
    },
  );
}

async function testTablesWithListCellsConvertToSingleLineRows() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const tableRows = index
          .split("\n")
          .filter((line) => line.trim().startsWith("|"));
        assert(
          tableRows.length === 3,
          `expected header + separator + 1 data row, got ${tableRows.length}`,
        );
        const dataRow = tableRows[2];
        assert(
          dataRow.includes("String match<br>Binary tests"),
          "expected list items flattened with <br>",
        );
        assert(
          dataRow.includes("Fast<br>Cheap"),
          "expected second cell flattened with <br>",
        );
      });
    },
  );
}

async function testDuplicateHtmlTitleHeadingIsDeduplicated() {
  // og:title differs from the body <h1> -- the old exact-match dedup missed this.
  const htmlBody = `<!doctype html>
<html><head>
<title>Building effective agents</title>
<meta property="og:title" content="Building Effective AI Agents">
</head>
<body><main><article>
<h1>Building effective agents</h1>
<p>Body text.</p>
</article></main></body></html>`;

  await withServer(
    { "/post": { contentType: "text/html; charset=utf-8", body: htmlBody } },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/post`, outDir]);
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const h1Count = (index.match(/^# /gm) || []).length;
        assert(h1Count === 1, `expected exactly one H1, got ${h1Count}`);
        assert(
          index.includes("# Building Effective AI Agents"),
          "expected provenance title preserved",
        );
        assert(index.includes("Body text."), "expected body content preserved");
      });
    },
  );
}

async function testDuplicateHtmlTitleHeadingIsDeduplicatedAfterLongChromePreamble() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const h1Count = (index.match(/^# /gm) || []).length;
        assert(
          h1Count === 1,
          `expected exactly one H1 after long preamble, got ${h1Count}`,
        );
        assert(
          index.includes("Body text after a long preamble."),
          "expected body content preserved",
        );
      });
    },
  );
}

async function testMarkdownPassthroughStripsPreambleAndMdxComponents() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const h1Count = (index.match(/^# /gm) || []).length;
        assert(
          h1Count === 1,
          `expected one H1 after preamble+dup strip, got ${h1Count}`,
        );
        assert(
          !index.includes("Documentation Index"),
          "expected llms.txt preamble removed",
        );
        assert(
          !index.includes("<CodeGroup>"),
          "expected MDX CodeGroup wrapper removed",
        );
        assert(!index.includes("<Note>"), "expected MDX Note wrapper removed");
        assert(
          !index.includes("theme={null}"),
          "expected theme={null} token removed",
        );
        assert(
          index.includes("print('hi')"),
          "expected fenced code content kept",
        );
        assert(
          index.includes("Remember this."),
          "expected Note inner text kept",
        );
        assert(
          index.includes("Real documentation prose."),
          "expected prose kept",
        );
      });
    },
  );
}

async function testJunkAssetsAreFilteredAndRealFiguresKept() {
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
      "/figure.png": { contentType: "image/png", body: PNG_FIGURE },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/page`, outDir]);
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        const assetFiles = await readdir(path.join(outDir, "assets"));
        assert(
          assetFiles.length === 1,
          `expected only the real figure kept, got ${assetFiles.join(",")}`,
        );
        assert(
          assetFiles[0].endsWith("real-figure.png"),
          "expected the real figure to be the kept asset",
        );
        assert(
          index.includes("![real figure](assets/01-real-figure.png)"),
          "expected real figure embedded",
        );
        assert(
          !index.includes("track"),
          "expected tracking pixel embed dropped",
        );
        assert(
          !index.includes("animation"),
          "expected non-image gif embed dropped",
        );
        assert(index.includes("Context paragraph."), "expected body text kept");
      });
    },
  );
}

async function testEmptyTextLinksAndSelfLinksAreCleaned() {
  // Empty-text link removal is exercised end-to-end on the main page; self-link
  // unwrapping is verified directly on tidyConvertedMarkdown, because a page's own
  // URL only collapses to its own filename on a fetched reference page (the main
  // page's outbound links localize to separate references/*.md copies).
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          !/\[\s*\]\(/.test(index),
          "expected no empty-text links remaining",
        );
        assert(
          index.includes("Edit button: here."),
          "expected surrounding text kept after icon-link removal",
        );
      });
    },
  );

  const withSelfLink =
    "See [tau2-bench paper](tau2-bench.md) and [other](https://x.example/y).";
  const unwrapped = tidyConvertedMarkdown(withSelfLink, "tau2-bench.md");
  assert(
    unwrapped.includes("See tau2-bench paper and"),
    "expected self-link unwrapped to plain text",
  );
  assert(
    unwrapped.includes("[other](https://x.example/y)"),
    "expected non-self link preserved",
  );
  const withTitledEmptyLinks =
    '[](https://a.example "title")[](https://b.example)';
  assert(
    tidyConvertedMarkdown(withTitledEmptyLinks) === "",
    "expected adjacent/titled empty links removed",
  );
}

async function testEmptyAltImagesRemainValidMarkdownImages() {
  const htmlBody = `<!doctype html>
<html><head><title>Hero</title></head>
<body><main><article>
<h1>Hero</h1>
<img src="/hero.png" alt="">
</article></main></body></html>`;

  await withServer(
    {
      "/hero": { contentType: "text/html; charset=utf-8", body: htmlBody },
      "/hero.png": { contentType: "image/png", body: PNG_FIGURE },
    },
    async (origin) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const result = await runCli([`${origin}/hero`, outDir]);
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("![](assets/01-hero.png)"),
          "expected empty-alt image markdown preserved",
        );
        assert(
          !index.split("\n").includes("!"),
          "expected no orphan exclamation-mark lines",
        );
      });
    },
  );
}

async function testFailureStubOmitsCurlProgressNoise() {
  await withServer(
    { "/missing": { status: 404, contentType: "text/plain", body: "nope" } },
    async (origin) => {
      await withTempDir(async (dir) => {
        const result = await runCli([
          `${origin}/missing`,
          path.join(dir, "out"),
        ]);
        // A direct 404 throws -> CLI exits non-zero; the error text must not carry
        // curl's progress-meter (the bug this guards against).
        assert(
          /HTTP 404|Not Found/i.test(result.stderr),
          "expected a 404 error message",
        );
        assert(
          !/% Total|% Received|Dload|Xferd/.test(result.stderr),
          "expected no curl progress-meter noise",
        );
      });
    },
  );
}

async function testDirectReferencesOnlyOnMainPage() {
  const refHtml = `<!doctype html><html><head><title>Reference One</title></head>
<body><main><article><h1>Reference One</h1><p>ref body</p>
<a href="https://ext-a.example.com/x">external a</a>
<a href="https://ext-b.example.com/y">external b</a>
</article></main></body></html>`;
  const mainHtml = `<!doctype html><html><head><title>Main Source</title></head>
<body><main><article><h1>Main Source</h1><p>intro</p>
<a href="REF_URL">Reference One</a>
</article></main></body></html>`;

  const server2 = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    if (req.url === "/main") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        mainHtml.replace(
          "REF_URL",
          `https://127.0.0.1:${server2.address().port}/ref`,
        ),
      );
      return;
    }
    if (req.url === "/ref") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(refHtml);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  try {
    await withTempDir(async (dir) => {
      const { port } = server2.address();
      const outDir = path.join(dir, "bundle");
      const result = await runCli([`https://127.0.0.1:${port}/main`, outDir]);
      assert(
        result.code === 0,
        `expected CLI success, got ${result.code}: ${result.stderr}`,
      );

      const index = await readFile(path.join(outDir, "index.md"), "utf8");
      assert(
        index.includes("## Direct References"),
        "expected main page to keep Direct References",
      );

      const refFiles = (await readdir(path.join(outDir, "references"))).filter(
        (f) => f.endsWith(".md"),
      );
      const refIndex = await readFile(
        path.join(outDir, "references", refFiles[0]),
        "utf8",
      );
      assert(
        !refIndex.includes("## Direct References"),
        "expected reference page to omit Direct References",
      );
    });
  } finally {
    await new Promise((resolve) => server2.close(() => resolve()));
  }
}

async function testUnlocalizedRelativeLinksAreAbsolutized() {
  const refHtml = `<!doctype html>
<html><head><title>Reference One</title></head>
<body><main><article>
<h1>Reference One</h1>
<p><a href="/docs/getting-started">Docs</a></p>
</article></main></body></html>`;
  const mainHtml = `<!doctype html><html><head><title>Main Source</title></head>
<body><main><article>
<h1>Main Source</h1>
<p><a href="REF_URL">Reference One</a></p>
</article></main></body></html>`;

  const server2 = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    if (req.url === "/main") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        mainHtml.replace(
          "REF_URL",
          `https://127.0.0.1:${server2.address().port}/ref`,
        ),
      );
      return;
    }
    if (req.url === "/ref") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(refHtml);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  try {
    await withTempDir(async (dir) => {
      const { port } = server2.address();
      const outDir = path.join(dir, "bundle");
      const result = await runCli([`https://127.0.0.1:${port}/main`, outDir]);
      assert(
        result.code === 0,
        `expected CLI success, got ${result.code}: ${result.stderr}`,
      );

      const refFiles = (await readdir(path.join(outDir, "references"))).filter(
        (f) => f.endsWith(".md"),
      );
      const refIndex = await readFile(
        path.join(outDir, "references", refFiles[0]),
        "utf8",
      );
      assert(
        refIndex.includes(
          `[Docs](https://127.0.0.1:${port}/docs/getting-started)`,
        ),
        "expected unresolved relative link absolutized",
      );
      assert(
        !refIndex.includes("[Docs](/docs/getting-started)"),
        "expected no broken root-relative link",
      );
    });
  } finally {
    await new Promise((resolve) => server2.close(() => resolve()));
  }
}

async function testStructuralChromeLinksAreNotBundledAsReferences() {
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
    title,
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("[developer docs](references/developer-docs.md)"),
          "expected content reference localized",
        );
        assert(
          !index.includes("Pricing"),
          "expected header nav text removed from output",
        );
        assert(
          !index.includes("Terms"),
          "expected footer text removed from output",
        );

        const manifest = JSON.parse(
          await readFile(
            path.join(outDir, "references", "references.json"),
            "utf8",
          ),
        );
        const originalUrls = Object.values(manifest).map(
          (entry) => entry.original_url,
        );
        assert(
          originalUrls.length === 1,
          `expected only one bundled reference, got ${originalUrls.join(", ")}`,
        );
        assert(
          originalUrls[0] === `${origin}/docs`,
          "expected only the article link to be bundled",
        );
      });
    },
  );
}

async function testLowSignalMarketingReferencesAreSkippedAfterFetch() {
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
        body: PNG_FIGURE,
      },
    },
    async ({ sourceOrigin, referenceOrigin }) => {
      await withTempDir(async (dir) => {
        const outDir = path.join(dir, "bundle");
        const productUrl = `${referenceOrigin}/`;
        const docsUrl = `${referenceOrigin}/docs`;
        const result = await runCli([`${sourceOrigin}/main`, outDir]);
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes(`[Bolt product homepage](${productUrl})`),
          "expected skipped link to remain external in body",
        );
        assert(
          index.includes("[Developer docs](references/developer-docs.md)"),
          "expected docs link localized in body",
        );
        assert(
          index.includes("## Direct References"),
          "expected Direct References section",
        );
        assert(
          index.includes("- [Developer Docs](references/developer-docs.md)"),
          "expected docs in Direct References",
        );
        assert(
          !index.includes("- [Bolt AI builder]("),
          "expected skipped marketing reference omitted from Direct References",
        );

        const referenceFiles = (
          await readdir(path.join(outDir, "references"))
        ).filter((file) => file.endsWith(".md"));
        assert(
          referenceFiles.length === 1,
          `expected only docs readable reference, got ${referenceFiles.join(",")}`,
        );
        assert(
          referenceFiles[0] === "developer-docs.md",
          "expected docs readable reference file",
        );

        const docs = await readFile(
          path.join(outDir, "references", "developer-docs.md"),
          "utf8",
        );
        assert(
          docs.includes("Configure evaluations"),
          "expected docs reference content bundled",
        );

        const manifest = JSON.parse(
          await readFile(
            path.join(outDir, "references", "references.json"),
            "utf8",
          ),
        );
        assert(
          manifest["references/developer-docs.md"].original_url === docsUrl,
          "expected docs manifest entry",
        );
        assert(
          manifest.skipped?.[productUrl],
          "expected skipped marketing reference recorded by original URL",
        );
        assert(
          manifest.skipped[productUrl].kind === "skipped",
          "expected skipped entry kind",
        );
        assert(
          manifest.skipped[productUrl].skipped_reason ===
            "low_signal_marketing_reference",
          "expected stable skipped reason",
        );
        assert(
          manifest.skipped[productUrl].label === "Bolt product homepage",
          "expected source-side label recorded",
        );
        assert(
          manifest.skipped[productUrl].title === "Build apps with AI",
          "expected fetched title recorded",
        );
        const referenceAssetsDir = path.join(outDir, "references", "assets");
        const referenceAssets = existsSync(referenceAssetsDir)
          ? await readdir(referenceAssetsDir, { recursive: true })
          : [];
        assert(
          !referenceAssets.some((file) => String(file).endsWith(".png")),
          "expected skipped page assets not localized",
        );
      });
    },
  );
}

async function testKnownProductHomepagesCanBeSkippedBeforeFetch() {
  const mainUrl = "https://research.example/articles/evals";

  const skipped = shouldSkipReferenceBeforeFetch({
    mainUrl,
    referenceUrl: "https://bolt.new/",
  });
  assert(
    skipped?.skipped_reason === "low_signal_marketing_reference",
    "expected known product homepage skipped before fetch",
  );

  assert(
    shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://anthropic.com/claude-code",
    })?.skipped_reason === "low_signal_marketing_reference",
    "expected path-specific Claude Code landing page skipped before fetch",
  );
  assert(
    shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://claude.com/product/claude-code",
    })?.skipped_reason === "low_signal_marketing_reference",
    "expected current Claude Code product landing page skipped before fetch",
  );
  assert(
    shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://claude.ai/code",
    })?.skipped_reason === "low_signal_marketing_reference",
    "expected Claude Code app landing page skipped before fetch",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://docs.bolt.new/getting-started",
    }),
    "expected docs subdomain protected",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://braintrust.dev/docs/guides",
    }),
    "expected docs path protected",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl:
        "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
    }),
    "expected article path protected on known product company domain",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://github.com/user/project",
    }),
    "expected repository source protected",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://example.org/",
    }),
    "expected unknown homepage to require fetch",
  );
  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl: "https://bolt.new/",
      referenceUrl: "https://bolt.new/",
    }),
    "expected main source never skipped",
  );
}

function lowSignalMarketingPageFixture() {
  return {
    mainHtml: `<main>
<section><h1>Build with AI</h1><p>Start for free and get started with our product.</p></section>
<section><h2>Trusted by leading teams</h2><p>Customers rely on this platform.</p></section>
<section><h2>Pricing that scales</h2><p>Choose Free, Pro, or Enterprise.</p></section>
<form><input name="email"><button>Sign up</button></form>
</main>`,
    articleHtml: "",
  };
}

async function testPostFetchSourceLikeSubdomainRootsStayBundleCandidates() {
  const mainUrl = "https://research.example/articles/evals";
  const page = lowSignalMarketingPageFixture();

  for (const subdomain of ["docs", "help", "developer", "developers", "api"]) {
    const referenceUrl = `https://${subdomain}.product.example/`;
    assert(
      !isLowSignalMarketingReference({ mainUrl, referenceUrl, page }),
      `expected ${referenceUrl} to remain bundleable after fetch`,
    );
  }
}

async function testPostFetchKnownProductLandingFinalUrlsCanBeSkipped() {
  const mainUrl = "https://research.example/articles/evals";
  const page = lowSignalMarketingPageFixture();

  assert(
    !shouldSkipReferenceBeforeFetch({
      mainUrl,
      referenceUrl: "https://links.example/r/claude-code",
    }),
    "expected ambiguous original URL to require fetch",
  );
  assert(
    isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://anthropic.com/claude-code",
      page,
    }),
    "expected known Claude Code landing final URL skipped after fetch",
  );
  assert(
    isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://claude.com/product/claude-code",
      page,
    }),
    "expected current Claude Code product landing final URL skipped after fetch",
  );
  assert(
    !isLowSignalMarketingReference({
      mainUrl,
      referenceUrl: "https://claude.com/blog/using-claude-code",
      page,
    }),
    "expected arbitrary source-like deep paths to remain bundle candidates",
  );
}

async function testKnownProductHomepageReferencesAreSkippedBeforeNetworkFetch() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );
        assert(
          result.stderr.includes(
            "Skipping low-signal reference https://bolt.new/",
          ),
          "expected skip message on stderr",
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("[Bolt homepage](https://bolt.new/)"),
          "expected skipped homepage link to remain external",
        );
        assert(
          index.includes("[Local docs](references/local-docs.md)"),
          "expected docs link localized",
        );
        assert(
          !index.includes("- [Bolt homepage]("),
          "expected skipped homepage omitted from Direct References",
        );
        assert(
          index.includes("- [Local Docs](references/local-docs.md)"),
          "expected docs in Direct References",
        );

        const manifest = JSON.parse(
          await readFile(
            path.join(outDir, "references", "references.json"),
            "utf8",
          ),
        );
        assert(
          manifest["references/local-docs.md"].original_url ===
            `${origin}/docs`,
          "expected docs manifest entry",
        );
        assert(
          manifest.skipped?.["https://bolt.new/"],
          "expected skipped known homepage manifest entry",
        );
        assert(
          manifest.skipped["https://bolt.new/"].label === "Bolt homepage",
          "expected skipped label retained",
        );
        assert(
          !("title" in manifest.skipped["https://bolt.new/"]),
          "expected pre-fetch skipped entry not to invent title",
        );
        assert(
          !("content_type" in manifest.skipped["https://bolt.new/"]),
          "expected pre-fetch skipped entry not to invent content type",
        );
      });
    },
  );
}

async function testArticleProseWithMarketingTermsStillBundles() {
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
        assert(
          result.code === 0,
          `expected CLI success, got ${result.code}: ${result.stderr}`,
        );

        const index = await readFile(path.join(outDir, "index.md"), "utf8");
        assert(
          index.includes("[Market analysis](references/market-analysis.md)"),
          "expected article link localized",
        );
        const reference = await readFile(
          path.join(outDir, "references", "market-analysis.md"),
          "utf8",
        );
        assert(
          reference.includes("compares pricing, customers, testimonials"),
          "expected article prose bundled",
        );

        const manifest = JSON.parse(
          await readFile(
            path.join(outDir, "references", "references.json"),
            "utf8",
          ),
        );
        assert(
          manifest["references/market-analysis.md"].original_url ===
            `${referenceOrigin}/analysis`,
          "expected article manifest entry",
        );
        assert(
          !manifest.skipped,
          "expected no skipped manifest for article prose false positive",
        );
      });
    },
  );
}

async function testSiteRulesStripKnownChrome() {
  // Site rules key on hostname, which the localhost test server cannot present,
  // so exercise the pure clean() functions directly via the built module.
  const arxiv = `<div class="subheader"><h1>Computer Science > Artificial Intelligence</h1></div>
<div class="header-breadcrumbs-mobile"><strong>arXiv:2504.12516</strong></div>
<div id="abs">
  <div class="dateline">[Submitted on 1 Apr 2025]</div>
  <h1 class="title mathjax"><span class="descriptor">Title:</span>BrowseComp</h1>
  <blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>We propose X.</blockquote>
</div>
<div class="browse">Current browse context: <div class="current">cs.AI</div></div>
<div class="extra-ref-cite"><h3>References &amp; Citations</h3><ul><li>NASA ADS</li></ul></div>
<div id='bib-cite-modal'><h2>BibTeX formatted citation</h2></div>
<div class='bookmarks'><h3>Bookmark</h3></div>
<div id='labstabs'><h1>Bibliographic and Citation Tools</h1></div>`;
  const a = applySiteRules(arxiv, "https://arxiv.org/abs/2504.12516");
  assert(a.includes("We propose X."), "arxiv: expected abstract kept");
  assert(
    !a.includes("Computer Science > Artificial Intelligence"),
    "arxiv: expected subject banner removed",
  );
  assert(
    !a.includes("Current browse context"),
    "arxiv: expected browse context removed",
  );
  assert(!a.includes("NASA ADS"), "arxiv: expected citation tail cut");
  assert(
    !a.includes("BibTeX formatted citation"),
    "arxiv: expected bibtex modal removed",
  );
  assert(!a.includes("Bookmark"), "arxiv: expected bookmark block removed");
  assert(
    !a.includes("Bibliographic and Citation Tools"),
    "arxiv: expected labs block removed",
  );

  const wiki = `<div id="mw-content-text"><div class="mw-content-ltr mw-parser-output">
<div class="mw-subjectpageheader"></div>
<div class="shortdescription">Model used in risk analysis</div>
<p class="mw-empty-elt"></p>
<p>Defenses <span class="mw-editsection">[edit]</span> overlap.</p>
<div class="mw-heading mw-heading2"><h2 id="References">References</h2><span class="mw-editsection">[edit]</span></div>
<div class="reflist"><ol><li>Reason 1990</li></ol></div>
</div><noscript></noscript><div class="printfooter">Retrieved from</div><div id="catlinks">Categories</div>`;
  const w = applySiteRules(
    wiki,
    "https://en.wikipedia.org/wiki/Swiss_cheese_model",
  );
  assert(w.includes("overlap"), "wikipedia: expected prose kept");
  assert(!w.includes("Reason 1990"), "wikipedia: expected reflist removed");
  assert(
    !w.includes("Retrieved from"),
    "wikipedia: expected print footer removed",
  );
  assert(!w.includes("Categories"), "wikipedia: expected catlinks removed");

  const gh = `<body><nav>file tree src/ tests/</nav><div class="Languages">Python 80.1%</div>
<article class="markdown-body"><h1>repo</h1><p>A benchmark.</p></article><div>star fork watch</div></body>`;
  const g = applySiteRules(gh, "https://github.com/sierra-research/tau2-bench");
  assert(g.includes("A benchmark."), "github: expected README kept");
  assert(
    !g.includes("file tree") && !g.includes("Python 80.1%"),
    "github: expected repo chrome dropped",
  );

  const bolt = `<html><head><title>Bolt AI builder: Websites, apps &amp; prototypes</title></head><body>
<header><nav><a href="/pricing">Pricing</a><a href="https://discord.com/invite/stackblitz">Community</a></nav></header>
<div><h1>What will you <span>build</span> today?</h1>
<p>Create stunning apps &amp; websites by chatting with AI.</p>
<button>Get started</button>
<div>Let&#x27;s build </div>
<button>Plan</button><button>Build now</button>
<p>or import from</p><button>Figma</button><button>GitHub</button></div>
<section><h2>Your company&#x27;s design system, now in Bolt</h2>
<p>Use your team&#x27;s components and brand guidelines to build for production</p>
<a href="https://support.bolt.new/building/design-system/introduction">Learn more</a></section>
<section><h2>The #1 professional vibe coding tool trusted by</h2></section>
<footer><a href="/terms">Terms</a></footer></body></html>`;
  const b = stripGenericChrome(applySiteRules(bolt, "https://bolt.new/"));
  assert(b.includes("What will you"), "bolt.new: expected hero kept");
  assert(
    b.includes("Create stunning apps"),
    "bolt.new: expected short product description kept",
  );
  assert(
    b.includes("Let&#x27;s build"),
    "bolt.new: expected prompt placeholder kept",
  );
  assert(
    !b.includes("Your company"),
    "bolt.new: expected design-system marketing section removed",
  );
  assert(
    !b.includes("Learn more"),
    "bolt.new: expected marketing link removed",
  );
  assert(
    !b.includes("The #1 professional"),
    "bolt.new: expected trust marketing section removed",
  );
  assert(
    !b.includes("Pricing") && !b.includes("Community") && !b.includes("Terms"),
    "bolt.new: expected nav/footer chrome removed",
  );
  assert(
    !b.includes("Build now") && !b.includes("Get started"),
    "bolt.new: expected button CTA text removed",
  );
  assert(
    !b.includes("or import from") &&
      !b.includes("Figma") &&
      !b.includes("GitHub"),
    "bolt.new: expected orphaned import UI removed",
  );

  const untouched = "<html><body><p>plain</p></body></html>";
  assert(
    applySiteRules(untouched, "https://example.com/x") === untouched,
    "non-match host: expected untouched",
  );
}

const tests = [
  testPackagedBinSymlinkRunsCliEntrypoint,
  testMarkdownResponsesRemainReadableSourceEntries,
  testJsonResponsesRemainUnformattedInsideFence,
  testBinaryResponsesCreateSourceAssetStub,
  testRedirectProvenanceRecordsRequestedFetchedAndFinalUrls,
  testInvalidUrlsFailBeforeFetchWithClearErrors,
  testHtmlPagesStillConvertAndBinaryReferencesArePreserved,
  testTablesWithListCellsConvertToSingleLineRows,
  testDuplicateHtmlTitleHeadingIsDeduplicated,
  testDuplicateHtmlTitleHeadingIsDeduplicatedAfterLongChromePreamble,
  testMarkdownPassthroughStripsPreambleAndMdxComponents,
  testJunkAssetsAreFilteredAndRealFiguresKept,
  testEmptyTextLinksAndSelfLinksAreCleaned,
  testEmptyAltImagesRemainValidMarkdownImages,
  testFailureStubOmitsCurlProgressNoise,
  testDirectReferencesOnlyOnMainPage,
  testUnlocalizedRelativeLinksAreAbsolutized,
  testStructuralChromeLinksAreNotBundledAsReferences,
  testLowSignalMarketingReferencesAreSkippedAfterFetch,
  testKnownProductHomepagesCanBeSkippedBeforeFetch,
  testPostFetchSourceLikeSubdomainRootsStayBundleCandidates,
  testPostFetchKnownProductLandingFinalUrlsCanBeSkipped,
  testKnownProductHomepageReferencesAreSkippedBeforeNetworkFetch,
  testArticleProseWithMarketingTermsStillBundles,
  testSiteRulesStripKnownChrome,
];

for (const test of tests) {
  await test();
}

console.log("preserved source ingest tests passed");
