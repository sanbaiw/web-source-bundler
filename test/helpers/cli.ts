import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(__dirname, "../..");
export const cliPath = path.resolve(repoRoot, "dist/cli.js");

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

function exitCode(error: ExecFileException | null): number {
  if (!error) {
    return 0;
  }
  return typeof error.code === "number" ? error.code : 1;
}

export function runCli(args: string[]): Promise<CommandResult> {
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
          code: exitCode(error),
          stdout,
          stderr,
        });
      },
    );
  });
}

export function runExecutable(
  executable: string,
  args: string[],
): Promise<CommandResult> {
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
          code: exitCode(error),
          stdout,
          stderr,
        });
      },
    );
  });
}

export async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version is missing");
  }
  return packageJson.version;
}
