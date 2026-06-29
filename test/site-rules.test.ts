import * as assert from "node:assert/strict";

import {
  applySiteRules,
  stripGenericChrome,
} from "../src/bundle-core/page-extraction";
import type { TestSuite } from "./helpers/test-runner";

function arxivSiteRuleStripsKnownChrome(): void {
  const html = `<div class="subheader"><h1>Computer Science > Artificial Intelligence</h1></div>
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
  const cleaned = applySiteRules(html, "https://arxiv.org/abs/2504.12516");

  assert.match(cleaned, /We propose X\./);
  assert.doesNotMatch(
    cleaned,
    /Computer Science > Artificial Intelligence|Current browse context|NASA ADS/,
  );
  assert.doesNotMatch(
    cleaned,
    /BibTeX formatted citation|Bookmark|Bibliographic and Citation Tools/,
  );
}

function wikipediaSiteRuleKeepsArticleProseAndDropsTailChrome(): void {
  const html = `<div id="mw-content-text"><div class="mw-content-ltr mw-parser-output">
<div class="mw-subjectpageheader"></div>
<div class="shortdescription">Model used in risk analysis</div>
<p class="mw-empty-elt"></p>
<p>Defenses <span class="mw-editsection">[edit]</span> overlap.</p>
<div class="mw-heading mw-heading2"><h2 id="References">References</h2><span class="mw-editsection">[edit]</span></div>
<div class="reflist"><ol><li>Reason 1990</li></ol></div>
</div><noscript></noscript><div class="printfooter">Retrieved from</div><div id="catlinks">Categories</div>`;
  const cleaned = applySiteRules(
    html,
    "https://en.wikipedia.org/wiki/Swiss_cheese_model",
  );

  assert.match(cleaned, /overlap/);
  assert.doesNotMatch(cleaned, /Reason 1990|Retrieved from|Categories/);
}

function githubSiteRuleKeepsReadmeAndDropsRepoChrome(): void {
  const html = `<body><nav>file tree src/ tests/</nav><div class="Languages">Python 80.1%</div>
<article class="markdown-body"><h1>repo</h1><p>A benchmark.</p></article><div>star fork watch</div></body>`;
  const cleaned = applySiteRules(
    html,
    "https://github.com/sierra-research/tau2-bench",
  );

  assert.match(cleaned, /A benchmark\./);
  assert.doesNotMatch(cleaned, /file tree|Python 80\.1%/);
}

function boltSiteRuleKeepsPromptShellAndDropsGenericMarketingChrome(): void {
  const html = `<html><head><title>Bolt AI builder: Websites, apps &amp; prototypes</title></head><body>
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
  const cleaned = stripGenericChrome(applySiteRules(html, "https://bolt.new/"));

  assert.match(cleaned, /What will you/);
  assert.match(cleaned, /Create stunning apps/);
  assert.match(cleaned, /Let&#x27;s build/);
  assert.doesNotMatch(
    cleaned,
    /Your company|Learn more|The #1 professional|Pricing|Community|Terms/,
  );
  assert.doesNotMatch(
    cleaned,
    /Build now|Get started|or import from|Figma|GitHub/,
  );
}

export const siteRulesSuite: TestSuite = {
  name: "site rules",
  tests: [
    {
      name: "arxiv rule strips known chrome",
      run: arxivSiteRuleStripsKnownChrome,
    },
    {
      name: "Wikipedia rule keeps article prose and drops tail chrome",
      run: wikipediaSiteRuleKeepsArticleProseAndDropsTailChrome,
    },
    {
      name: "GitHub rule keeps README and drops repo chrome",
      run: githubSiteRuleKeepsReadmeAndDropsRepoChrome,
    },
    {
      name: "Bolt rule keeps prompt shell and drops generic marketing chrome",
      run: boltSiteRuleKeepsPromptShellAndDropsGenericMarketingChrome,
    },
  ],
};
