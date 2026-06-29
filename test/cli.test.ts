import * as assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import path from "node:path";

import { cliPath, packageVersion, runCli, runExecutable } from "./helpers/cli";
import { withServer } from "./helpers/server";
import { withTempDir } from "./helpers/temp";
import type { TestSuite } from "./helpers/test-runner";

async function symlinkedBinRunsCliEntrypoint(): Promise<void> {
  await withTempDir(async (dir) => {
    const binPath = path.join(dir, "web-source-bundler");
    await symlink(cliPath, binPath);

    const help = await runExecutable(binPath, ["--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(
      help.stdout,
      /web-source-bundler \[options\] <url> <output-dir>/,
    );

    const version = await runExecutable(binPath, ["--version"]);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), await packageVersion());
  });
}

async function invalidUrlsFailBeforeFetchWithClearErrors(): Promise<void> {
  await withTempDir(async (dir) => {
    const dotless = await runCli([
      "https://localhost/source.md",
      path.join(dir, "dotless"),
    ]);
    assert.notEqual(dotless.code, 0);
    assert.match(dotless.stderr, /hostname must contain a dot/);

    const credentials = await runCli([
      "https://user:pass@127.0.0.1/source.md",
      path.join(dir, "credentials"),
    ]);
    assert.notEqual(credentials.code, 0);
    assert.match(credentials.stderr, /username and password are not allowed/);
  });
}

async function failureStubOmitsCurlProgressNoise(): Promise<void> {
  await withServer(
    { "/missing": { status: 404, contentType: "text/plain", body: "nope" } },
    async (origin) => {
      await withTempDir(async (dir) => {
        const result = await runCli([
          `${origin}/missing`,
          path.join(dir, "out"),
        ]);

        assert.match(result.stderr, /HTTP 404|Not Found/i);
        assert.doesNotMatch(result.stderr, /% Total|% Received|Dload|Xferd/);
      });
    },
  );
}

export const cliSuite: TestSuite = {
  name: "cli",
  tests: [
    {
      name: "symlinked bin runs the CLI entrypoint",
      run: symlinkedBinRunsCliEntrypoint,
    },
    {
      name: "invalid URLs fail before fetch with clear errors",
      run: invalidUrlsFailBeforeFetchWithClearErrors,
    },
    {
      name: "HTTP failure output omits curl progress noise",
      run: failureStubOmitsCurlProgressNoise,
    },
  ],
};
