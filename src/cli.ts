#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle } from "./bundle-core/build-bundle";

const CLI_VERSION = "0.1.0";

function usage(exitCode = 1): never {
  const text = `Usage:
  web-source-bundler [options] <url> <output-dir>

Options:
  --no-svg2png   Keep SVG images as-is instead of converting to PNG (default: convert)
  -h, --help     Show this help message
  --version      Print the CLI version

The command fetches and preserves a source URL, writes a readable Markdown
entry, downloads each direct reference into the references directory, downloads
page images, rewrites local cross-links, and writes references/references.json.`;
  if (exitCode === 0) {
    console.log(text);
  } else {
    console.error(text);
  }
  process.exit(exitCode);
}

function parseArgs(argv: string[]): {
  url: string;
  outDir: string;
  svg2png: boolean;
} {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("-h") || args.includes("--help")) {
    usage(0);
  }

  if (args.includes("--version")) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  let svg2png = true;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--no-svg2png") {
      svg2png = false;
      continue;
    }
    if (arg.startsWith("-")) {
      usage();
    }
    positional.push(arg);
  }

  if (positional.length !== 2) {
    usage();
  }

  const url = positional[0];
  const outDir = positional[1];
  if (!url || !outDir) {
    usage();
  }
  return {
    url,
    outDir,
    svg2png,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await buildBundle(args.url, args.outDir, { svg2png: args.svg2png });
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === thisFile;
  } catch {
    return path.resolve(process.argv[1]) === thisFile;
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
