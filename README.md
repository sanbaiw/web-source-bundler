# web-source-bundler

`web-source-bundler` fetches a web source, preserves the fetched response, and writes a local Markdown bundle with references and assets.

The tool is inspired by agent web-fetch/web-search pipelines: keep the source provenance and original bytes first, then create a readable Markdown entry for downstream knowledge-base or wiki workflows.

## Usage

```bash
npx web-source-bundler https://example.com ./raw/example
pnpm dlx web-source-bundler https://example.com ./raw/example
```

Options:

```bash
web-source-bundler [options] <url> <output-dir>

--no-svg2png   Keep SVG images as-is instead of converting to PNG.
--version      Print the CLI version.
```

The command writes:

- `index.md` for the primary source entry.
- `assets/` for localized primary-source assets or binary source payloads.
- `references/*.md` for direct reference pages.
- `references/assets/` for binary reference payloads.
- `references/references.json` for reference provenance.

## Cleanup behavior

The bundle aims to be a faithful, readable archive, so conversion applies some
zero-config cleanup:

- **Tables** with list/`<br>` cells are flattened to valid single-line GFM rows
  (cell content joined with `<br>`) instead of collapsing into an unrenderable
  multi-line blob.
- **Duplicate titles** are de-duplicated: the entry's provenance header already
  emits `# {title}`, so a redundant leading `<h1>` (HTML) or leading `# title`
  and llms.txt discovery preamble (Markdown passthrough) are dropped.
- **Asset hygiene** drops tracking pixels, favicons, share badges, and UI icons
  by content sniffing (a payload that is not really an image is rejected), a byte
  floor, and a pixel-dimension floor. Genuine figures are kept; assets with
  unknown dimensions are never dropped on that basis alone.
- **Generic chrome** removal strips `<aside>` / `role=navigation|complementary|
  banner|contentinfo` regions, empty-text `[](url)` links, self-referential
  links, and stray `[edit]` markers.
- **MDX/JSX wrappers** (`<CodeGroup>`, `<Tabs>`, `<Card>`, `theme={null}`, …) are
  stripped from docs served as `text/markdown`, keeping the inner content.
- **Direct References** are listed only on the main `index.md` (where they are
  localized to the bundled files), not on each reference page.
- **Low-signal marketing/product homepage references** may be skipped when they
  are Direct References rather than the primary source. Skipped references remain
  as external links in the source body, are omitted from readable reference pages
  and the Direct References section, and are recorded under
  `references/references.json` as `skipped` entries with
  `skipped_reason: "low_signal_marketing_reference"`.

### Site rules

Some boilerplate is site-specific. A small built-in registry (`SITE_RULES` in
`src/cli.mjs`) ships default cleaners that run with no configuration:

- **arXiv** — keeps the abstract, cuts the "References & Citations" tool/footer tail.
- **Wikipedia** — drops the reference list, navboxes, `[edit]` markers, and category footer.
- **GitHub** — keeps the rendered README, drops the file tree, language bar, and social chrome.

Each rule is `{ id, test(hostname), clean(html) }`. To support another site, add
an entry; to change behavior, replace one. Non-matching hosts pass through the
generic pass only.

## Known limitations

- **No JavaScript execution.** The fetch returns the pre-render HTML (with a curl
  fallback). Content injected client-side after load — e.g. leaderboards that
  render from JSON, or lazily-loaded citation widgets — is not captured and may
  appear as a "Loading…" placeholder. Adding a headless browser is intentionally
  out of scope to keep the tool lightweight.

## Development

This repo uses Bun for dependency management, building, and tests.

```bash
bun install
bun run build
bun run test
```

The published package exposes one CLI bin: `web-source-bundler`.
