#!/usr/bin/env node
/**
 * build-canary-issue-body.mjs — Format the article-content canary JSON
 * output as a Markdown body for the auto-created GitHub issue.
 *
 * Pulled out of the workflow YAML so the (multi-line, backtick-heavy)
 * template is shell-quote-safe and easy to unit-test.
 *
 * Usage:
 *   node scripts/build-canary-issue-body.mjs canary-result.json
 *
 * Env:
 *   RUN_URL — workflow run URL injected into the issue body. Optional.
 */

import fs from "node:fs";
import process from "node:process";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: build-canary-issue-body.mjs <canary-result.json>");
  process.exit(2);
}

const runUrl = process.env.RUN_URL || "(unknown)";

let report = null;
try {
  if (fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0) {
    report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }
} catch (err) {
  console.error(`[build-canary-issue-body] could not parse ${inputPath}: ${err.message}`);
}

if (!report) {
  process.stdout.write(
    [
      "## Article content regression detected",
      "",
      "The canary script failed before producing a JSON result. Inspect `canary.log` in the workflow run artifacts.",
      "",
      `**Workflow run:** ${runUrl}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const ts = report.timestamp || new Date().toISOString();
const lines = [];
lines.push("## Article content regression detected");
lines.push("");
lines.push(`**When:** ${ts}`);
lines.push(`**Sample:** ${report.sampleSize} random articles from sitemap-blog.xml`);
lines.push(`**Result:** ${report.pass} pass, ${report.fail} fail`);
lines.push(`**Workflow run:** ${runUrl}`);
lines.push("");
lines.push("### Failing URLs");
const failures = Array.isArray(report.failures) ? report.failures : [];
for (const f of failures.slice(0, 25)) {
  lines.push(`- ${f.url}`);
  const detail = f.reason + (f.bytes !== undefined ? ` (body=${f.bytes} bytes)` : "");
  lines.push(`  - reason: ${detail}`);
}
if (failures.length > 25) {
  lines.push(`- … ${failures.length - 25} more (see canary-result.json artifact)`);
}
lines.push("");
lines.push("### Likely root causes");
lines.push(
  "1. Plugin emitting `<dir>/.html` dotfile (`path + '.html'` over a slash-terminated path). Pre-deploy gate `audit:no-dotfile-html` should catch this — if it slipped through, inspect recent ogPagesPlugin / jobsSeoPagesPlugin / staticPagesPlugin changes.",
);
lines.push("2. Validate-live ratchet drift (SPA bundle injection baseline raised too high to catch new regressions).");
lines.push("3. GitHub Pages routing quirk for a newly-emitted URL class.");
lines.push("4. Accidental redeploy of an older artifact via the rollback fallback path.");
lines.push("");
lines.push("### Next steps");
lines.push("1. Curl a failing URL: `curl -sI <url>` — confirm content-type / content-length match the canary report.");
lines.push("2. `curl -sI <url>index.html` — if `/index.html` returns a different (larger) body, this is the dotfile-bridge class.");
lines.push("3. `gh run view <recent-deploy-run-id> --log | grep audit-no-dotfile-html` — verify the pre-deploy gate ran on the build that shipped.");
lines.push("4. If RPM is degrading, rollback via `gh workflow run deploy.yml --ref $(node scripts/deploy-registry.mjs get-good | jq -r .sha)`.");
lines.push("");

process.stdout.write(lines.join("\n"));
