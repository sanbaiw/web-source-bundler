import { bundleOutputSuite } from "./bundle-output.test";
import { cliSuite } from "./cli.test";
import { directReferencesSuite } from "./direct-references.test";
import { runSuites } from "./helpers/test-runner";
import { marketingReferencesSuite } from "./marketing-references.test";
import { renderingSuite } from "./rendering.test";
import { siteRulesSuite } from "./site-rules.test";
import { sourcePreservationSuite } from "./source-preservation.test";

await runSuites([
  cliSuite,
  sourcePreservationSuite,
  bundleOutputSuite,
  renderingSuite,
  directReferencesSuite,
  marketingReferencesSuite,
  siteRulesSuite,
]);
