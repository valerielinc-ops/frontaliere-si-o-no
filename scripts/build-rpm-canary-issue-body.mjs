#!/usr/bin/env node
/**
 * build-rpm-canary-issue-body.mjs — Format the RPM canary JSON output
 * as a Markdown body for the auto-created GitHub issue.
 *
 * Usage:
 *   node scripts/build-rpm-canary-issue-body.mjs rpm-canary-result.json
 *
 * Env:
 *   RUN_URL — workflow run URL injected into the issue body. Optional.
 */

import fs from "node:fs";
import process from "node:process";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: build-rpm-canary-issue-body.mjs <rpm-canary-result.json>");
  process.exit(2);
}

const runUrl = process.env.RUN_URL || "(unknown)";

let r = null;
try {
  if (fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0) {
    r = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }
} catch (err) {
  console.error(`[build-rpm-canary-issue-body] parse error: ${err.message}`);
}

// Only bail on a genuinely unusable result (parse failure / no result at
// all). A regression can now be triggered by the coverage check alone
// (issue #4610) even when classifyRpm() itself returned insufficient-data
// (no `current`/`baseline`) — every section below guards its own fields
// instead of requiring the full RPM shape up front, so that alert still
// gets a real body instead of falling back to the generic failure message.
if (!r) {
  process.stdout.write(
    [
      "## RPM canary alert",
      "",
      "The RPM canary failed before producing a usable JSON result. See `rpm-canary.log` artifact.",
      "",
      `**Workflow run:** ${runUrl}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const isCoverageOnly = r.verdict === "coverage-regression" && !(r.reasons || []).some((x) => /RPM .*baseline|Earnings .*baseline/.test(x));

const lines = [];
lines.push(isCoverageOnly ? "## Sustained AdSense ad-request coverage degradation" : "## AdSense RPM crash detected");
lines.push("");
lines.push(`**When detected:** ${r.timestamp || "(unknown)"}`);
lines.push(`**Account:** ${r.account || "(unknown)"}`);
lines.push(`**Trigger:** ${r.verdict || "(unknown)"}`);
lines.push(`**Workflow run:** ${runUrl}`);
lines.push("");
if (r.current && r.baseline) {
  lines.push("### Numbers");
  lines.push("");
  lines.push(`| Metric | Current (${r.current.date}) | Baseline (${r.baseline.from}..${r.baseline.to}) |`);
  lines.push("|---|---:|---:|");
  lines.push(`| PV-RPM (CHF) | **${r.current.rpm.toFixed(2)}** | ${r.baseline.rpm.toFixed(2)} |`);
  lines.push(`| Earnings (CHF) | ${r.current.earnings.toFixed(2)} | ${r.baseline.earnings.toFixed(2)} |`);
  lines.push(`| Page views | ${r.current.pageViews} | — |`);
  lines.push("");
  lines.push(`**RPM ratio current/baseline:** ${(r.ratio * 100).toFixed(0)}%`);
  if (typeof r.earningsRatio === "number") {
    lines.push(`**Earnings ratio current/baseline:** ${(r.earningsRatio * 100).toFixed(0)}%`);
  }
  const earningsFloorTxt =
    r.floors && typeof r.floors.earnings === "number"
      ? ` AND earnings < ${(r.floors.earnings * 100).toFixed(0)}% of baseline`
      : "";
  lines.push(
    `**Thresholds:** (RPM ratio < ${(r.floors.ratio * 100).toFixed(0)}% OR absolute < ${r.floors.absoluteCHF.toFixed(2)} CHF)${earningsFloorTxt}`,
  );
  lines.push("");
  lines.push(
    "> This alert fires only when earnings are ALSO down — a low RPM with healthy earnings is a benign page-view spike (bot/AI crawl or a Discover hit), not lost revenue. Because earnings are confirmed down here, treat it as a real revenue regression and work the checklist below.",
  );
  lines.push("");
}
if (r.coverage && r.coverage.window) {
  lines.push("### Coverage check — sustained degradation (issue #4610)");
  lines.push("");
  lines.push(
    "> This check is deliberately NOT relative to a moving baseline: the RPM/earnings gate above compares against a trailing 7-day window that ADAPTS once a degradation lasts longer than that — issue #4610 fired once (2026-07-20) and stayed green for weeks afterward while AdSense account coverage kept falling, because the baseline had drifted down with it. This check compares against a fixed floor instead, so it cannot be \"adapted to\".",
  );
  lines.push("");
  lines.push(
    `Trailing ${r.coverage.window.days}-day average AD_REQUESTS_COVERAGE (${r.coverage.window.from}..${r.coverage.window.to}): **${(r.coverage.avgCoverage * 100).toFixed(0)}%** — floor ${(r.coverage.floor * 100).toFixed(0)}% — verdict **${r.coverage.verdict}**`,
  );
  lines.push("");
  if (Array.isArray(r.coverage.coverage) && r.coverage.coverage.length > 0) {
    lines.push("| Date | AD_REQUESTS_COVERAGE |");
    lines.push("|---|---:|");
    for (const day of r.coverage.coverage) {
      lines.push(`| ${day.date} | ${(day.coverage * 100).toFixed(0)}% |`);
    }
    lines.push("");
  }
} else if (r.coverage && r.coverage.reason) {
  lines.push(`_Coverage check skipped: ${r.coverage.reason}_`);
  lines.push("");
}
lines.push("### Triggered conditions");
for (const reason of r.reasons || []) {
  lines.push(`- ${reason}`);
}
lines.push("");
if (Array.isArray(r.rows) && r.rows.length > 0) {
  const hasCoverage = r.rows.some((row) => Number.isFinite(row.coverage));
  lines.push("### Daily history (last 14 days)");
  lines.push("");
  lines.push(hasCoverage ? "| Date | RPM (CHF) | Earnings (CHF) | Page views | Coverage |" : "| Date | RPM (CHF) | Earnings (CHF) | Page views |");
  lines.push(hasCoverage ? "|---|---:|---:|---:|---:|" : "|---|---:|---:|---:|");
  for (const row of r.rows) {
    const cells = [row.date, row.rpm.toFixed(2), row.earnings.toFixed(2), String(row.pageViews)];
    if (hasCoverage) cells.push(Number.isFinite(row.coverage) ? `${(row.coverage * 100).toFixed(0)}%` : "—");
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
}
lines.push("### Diagnostic checklist (in priority order)");
lines.push("");
lines.push("1. **Article-content canary status** — check the latest run of `article-content-canary.yml`. If it also failed, the cause is upstream HTML (stubs, missing SPA bundle, etc.) and the fix lives in build plugins. If it passed, the cause is downstream of the served HTML.");
lines.push("2. **Recent deploys** — `gh run list --branch main --limit 20 --workflow=233284293`. A failed `validate-live` + failed `rollback` is the incident-2026-05-28 signature.");
lines.push("3. **AdSense console** — Sites tab for ads.txt / policy issues; Performance tab for reach by ad format (Auto Ads disabled? Anchor ads serving?).");
lines.push("4. **Unmatched ad requests + coverage** — pull a 14-day daily report dimensioned by `TARGETING_TYPE_NAME` and look for spike in `None` / `(Unmatched ad requests)`. A spike here is the article-stub fingerprint.");
lines.push("5. **PostHog $web_vitals** — CLS regression can suppress vignettes and anchor ads; check the last few daily snapshots.");
lines.push("");
lines.push("### Manual rollback (if needed)");
lines.push("");
lines.push("```bash");
lines.push("gh workflow run deploy.yml --ref $(node scripts/deploy-registry.mjs get-good | jq -r .sha)");
lines.push("```");
lines.push("");

process.stdout.write(lines.join("\n"));
