# PLAN: web-source-bundler fidelity + cleanup pass

## Context

`src/cli.mjs` (1359 lines, single file) fetches a source URL, preserves the raw
response, and writes a Markdown bundle (`index.md` + `references/*.md` + assets +
`references.json`). A review of its capture of the Anthropic "Demystifying evals
for AI agents" article surfaced 13 recurring defects. All trace to specific code
and have been verified against the produced `raw/` output.

This plan fixes them while honoring the agreed design principle:

> The tool stays **lightweight**, covers **generic scenes with zero
> configuration**, and is **configurable/extensible** where per-site knowledge
> helps. No heavyweight dependencies (no headless browser).

Site-specific knowledge therefore lives as **built-in defaults in an extensible
registry** (a list of `{ id, test(url), clean(html) }` rules), not as hardcoded
branches in the conversion flow and not as user-supplied config. arXiv /
Wikipedia / GitHub ship as defaults so common sources work out of the box; adding
or overriding a rule is a localized edit (and can later be fed from external
config without touching the core).

## Defect -> root cause -> fix (all verified against raw/)

### Tier 1 -- fidelity bug fixes (generic, zero-config)

1. **Broken tables** (4 in `index.md`, plus OSWorld/WebArena/alignment-auditing).
   Root: gfm's `cell()` keeps newlines from `<ul>`/`<li>`/`<br>` inside `<td>`;
   GFM requires one physical line per row. Verified `index.md:109-125`.
   Fix: register a custom `tableCell` rule AFTER `td.use(gfm)`. `addRule` unshifts,
   and `Rules.forNode` returns the first match, so our rule (filter `['th','td']`)
   overrides gfm's. Replacement replicates gfm's prefix logic (`| ` for cell 0,
   ` ` otherwise, trailing ` |`) but flattens internal newlines and list markers
   into `<br>`-separated text (GFM renders `<br>` inside cells).
   Note: gfm keeps header-less tables as raw `<table>` HTML (its `table` rule only
   fires when row 0 is all `<th>`); that is acceptable fidelity and left as-is.

2. **Duplicate H1, HTML path.** Root: `removeDuplicateTitleHeading` only strips the
   body H1 on an *exact* slug match, so og:title "Building Effective AI Agents" !=
   body h1 "Building effective agents" leaves both. Verified
   `building-effective-ai-agents.md:1` vs `:26`.
   Fix: we always emit our own `# {title}` provenance header, so the first in-body
   `<h1>` is always redundant -- strip it unconditionally (keep the existing
   first-2000-chars guard; only the first H1). Rename to `stripLeadingBodyH1`.

3. **Duplicate H1, markdown passthrough.** Root: `renderTextSourceEntry` prepends
   `# {title}` to a body that already opens with the same `# {title}` (plus a
   Mintlify `> ## Documentation Index ...` llms.txt preamble). Verified
   `agent-sdk-overview.md:1` vs `:11`.
   Fix: in `renderTextSourceEntry`, for markdown subtype strip a leading body H1
   that matches the title (fuzzy slug compare) and the llms.txt preamble blockquote.

4. **Curl stderr leaked into output.** Root: `curlFetchSource` runs curl without
   `-sS`, so the transfer **progress meter** (stderr) is concatenated into
   `failReason`, which `writeFailureStub` prints. Verified `langfuse-com.md`.
   Fix: add `-sS` to the curl args in `curlFetchSource` AND in `downloadBinary`'s
   curl fallback. Defense-in-depth: collapse `failReason` to its first line.

5. **Empty-text links** `[](url)` (swe-bench, opus-4-5 social-share). Root: anchors
   whose only child was an icon/`<img>` (stripped) convert to `[](url)`. Verified
   `swe-bench.md:41,55,61`.
   Fix: generic post-pass on converted markdown removing `[](url)` /
   `[ ](url)` (empty or whitespace-only link text).

6. **Dead relative image embeds** (alignment-auditing: 19 `![](figN.png)` with an
   empty assets dir). Root: when download fails, the image is skipped and not added
   to the localize map, so `replaceImagesWithLocalPaths` leaves the original
   (often relative) `src`.
   Fix: in `replaceImagesWithLocalPaths`, when there is no local target, rewrite
   `src` to the resolved **absolute** URL so the embed is at least a working link.

7. **Self-referential links** (cite-as / logo links -> own `.md`). Root:
   `replaceAnchorsWithLocalLinks` maps the page's own URL to its own path.
   Fix: if the resolved local target equals the page's own `relativePath`, unwrap
   to plain text instead of emitting a self-link.

### Tier 2 -- asset hygiene (generic, zero-config)

8. **Junk assets**: 1x1 tracking pixels (`.bin`, `pixel.gif`, 68 B), license badges
   (80x15), favicons/avatars, customer-logo walls, and an HTML "Wikimedia Error"
   page saved as `03-...covid....gif`. Root: `shouldExcludeImage` only matches the
   word "logo" in alt/filename; no content or size validation. Verified via `file`.
   Fix in `downloadImagesForPage` / `shouldExcludeImage`:
   - **Magic-byte validation**: after download, confirm bytes start with a known
     image signature (reuse the sniffing in `sourceClassificationFromBytes`);
     skip otherwise (kills HTML-saved-as-gif).
   - **Size floor**: skip < ~1 KB (kills tracking pixels, tiny badges).
   - **Dimension floor**: read `sharp(buffer).metadata()` (sharp already a dep);
     skip when both width and height <= 48 px (kills favicons/avatars/badges).
     If dimensions are unknown (e.g. some SVG), do NOT skip.
   - Modestly extend name patterns: `-icon`/`icon-`, `avatar`, `pixel`, `spacer`,
     `badge`, `chevron`, `arrow`. (Size/dimension floors do the heavy lifting;
     name matching stays conservative to avoid dropping real figures.)

### Tier 3 -- chrome cleanup (light generic + extensible site rules)

9. **Generic structural strip** (always on). Extend `cleanHtml` to also drop
   `<aside>` and `[role=navigation|complementary|banner|contentinfo]` regions and
   `[edit]` markers. Conservative -- only well-known non-content roles.

10. **Generic MDX/JSX strip** (markdown path; agent-sdk, langsmith). Remove unrendered
    docs-component wrapper tags (`<CodeGroup>`, `<CardGroup>`, `<Card .../>`,
    `<Tabs>`, `<Tab>`, `<Steps>`, `<Step>`, `<Note>`, `<Tip>`, `<Columns>`,
    `<Tooltip>`, `<div className=...>`) and strip ` theme={null}` from code-fence
    info strings. Keep inner content. This is a common docs pattern, so it is
    generic, not site-specific.

11. **Site-rule registry** (built-in defaults, extensible). New
    `SITE_RULES = [{ id, test(url), clean(html) }]`, applied in `parsePage` before
    the generic clean when `test(page.url)` matches:
    - **arXiv** (`arxiv.org`): cut everything from the "References & Citations"
      marker onward (citation-tool/MathJax/footer tail, ~130 lines); drop
      browse-context / prev-next nav. Verified `browsecomp...md:92-120`.
    - **Wikipedia** (`*.wikipedia.org`): drop the reflist/citation dump, `[edit]`
      markers, `#catlinks` categories, navboxes, and "Retrieved from".
    - **GitHub** (`github.com`): keep the README (`article.markdown-body`), drop the
      file-tree listing, language bar, and star/fork/watch chrome (~700 lines on
      tau2-bench).

12. **Direct References dump only on the main page.** Root: `buildReferenceSection`
    runs for every page; on reference pages the links are non-localized external
    URLs (40-48 of them = pure noise). Fix: emit "## Direct References" only for the
    main `index.md` page (where links are localized and are the bundle's purpose);
    omit on reference pages.

### Tier 4 -- docs

13. **README**: add a "Known limitations" note that JS-rendered content (client-side
    leaderboards like OSWorld/Terminal-Bench, lazy-loaded arXiv BibTeX) is not
    executed -- the fetch returns pre-render HTML by design. Briefly document the
    site-rule registry as the extension point and the asset-filtering behavior.

## Out of scope

- **Headless JS rendering** (Playwright/Puppeteer) -- rejected: violates the
  lightweight principle. Documented as a known limitation instead (Tier 4).
- **Markdown over-escaping** (`\*\*OSWorld\*\*`) -- niche to one page; a global
  unescape pass is risky. Left as-is; may revisit if it recurs.

## Files changed

- `src/cli.mjs` -- all code changes above. Likely touch points: `cleanHtml`,
  `removeDuplicateTitleHeading` -> `stripLeadingBodyH1`, `extractArticle`/`parsePage`
  (apply site rules), new `SITE_RULES` registry + `applySiteRules`, new generic
  markdown post-pass (`tidyConvertedMarkdown`), `renderMarkdown` (custom tableCell
  rule, self-link unwrap, dead-image fallback, ref-section gating), 
  `renderTextSourceEntry` (MDX strip + dup-H1), `curlFetchSource` + `downloadBinary`
  (`-sS`), `downloadImagesForPage` + `shouldExcludeImage` (asset filter).
- `test/preserved-source-ingest.test.mjs` -- add cases (below).
- `README.md` -- known limitations + extensibility.
- Rebuild `dist/cli.js` via `bun run build` (tests run against dist).

## New tests (extend existing harness; same TLS-server pattern)

- Table with `<ul>`/`<br>` cell -> single-line GFM row (no intra-cell newline).
- HTML dup-H1: og:title != body h1 -> exactly one H1 in output.
- Markdown passthrough dup-H1 + llms.txt preamble -> one H1, preamble gone.
- MDX strip: `<CodeGroup>`/`<Tabs>`/`theme={null}` removed, inner code kept.
- Empty-text link `[](url)` removed; real links kept.
- Asset filter: 1x1 PNG pixel skipped; HTML-bytes-with-.gif-url skipped; a real
  >48px image kept.
- Site rule (synthetic arXiv-shaped HTML with a "References & Citations" marker) ->
  tail stripped.
- Reference page omits "## Direct References"; main page keeps it.
- Regression: existing 7 tests still pass (esp. GFM `| Name |`, markdown/json/pdf
  preservation, redirect provenance).

## Validation

1. `bun run build && bun run test` -- all tests green.
2. Optional spot re-bundle of the live article to eyeball tables/H1/chrome.
   NOTE: re-bundling overwrites `raw/` (network fetch); only do this if you want a
   fresh capture, and expect minor diffs from live-site changes.

## Sequencing

Tier 1 + 2 first (independent, high-value, low-risk), each with its test. Then
Tier 3 (registry + generic chrome), then Tier 4 docs. Build + test after each tier.
