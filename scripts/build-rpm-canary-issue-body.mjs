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

if (!r || !r.current) {
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

const lines = [];
lines.push("## AdSense RPM crash detected");
lines.push("");
lines.push(`**When detected:** ${r.timestamp || "(unknown)"}`);
lines.push(`**Account:** ${r.account || "(unknown)"}`);
lines.push(`**Workflow run:** ${runUrl}`);
lines.push("");
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
lines.push("### Triggered conditions");
for (const reason of r.reasons || []) {
  lines.push(`- ${reason}`);
}
lines.push("");
if (Array.isArray(r.rows) && r.rows.length > 0) {
  lines.push("### Daily history (last 14 days)");
  lines.push("");
  lines.push("| Date | RPM (CHF) | Earnings (CHF) | Page views |");
  lines.push("|---|---:|---:|---:|");
  for (const row of r.rows) {
    lines.push(`| ${row.date} | ${row.rpm.toFixed(2)} | ${row.earnings.toFixed(2)} | ${row.pageViews} |`);
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
