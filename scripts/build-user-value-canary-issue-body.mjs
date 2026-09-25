#!/usr/bin/env node
/**
 * build-user-value-canary-issue-body.mjs — Format the user-value (ARPU)
 * canary JSON output as a Markdown body for the auto-created GitHub issue.
 *
 * Usage:
 *   node scripts/build-user-value-canary-issue-body.mjs user-value-canary-result.json
 *
 * Env:
 *   RUN_URL — workflow run URL injected into the issue body. Optional.
 */

import fs from "node:fs";
import process from "node:process";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: build-user-value-canary-issue-body.mjs <user-value-canary-result.json>");
  process.exit(2);
}

const runUrl = process.env.RUN_URL || "(unknown)";

let r = null;
try {
  if (fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0) {
    r = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }
} catch (err) {
  console.error(`[build-user-value-canary-issue-body] parse error: ${err.message}`);
}

if (!r || !r.current) {
  process.stdout.write(
    [
      "## User-value canary alert",
      "",
      "The user-value (ARPU) canary failed before producing a usable JSON result. See `user-value-canary.log` artifact.",
      "",
      `**Workflow run:** ${runUrl}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const lines = [];
lines.push("## User-value (ARPU) crash detected");
lines.push("");
lines.push(`**When detected:** ${r.timestamp || "(unknown)"}`);
lines.push(`**GA4 property:** ${r.propertyId || "(unknown)"}`);
lines.push(`**Workflow run:** ${runUrl}`);
lines.push("");
lines.push("### Numbers");
lines.push("");
lines.push(`| Metric | Current (${r.current.date}) | Baseline (${r.baseline.from}..${r.baseline.to}) |`);
lines.push("|---|---:|---:|");
lines.push(`| ARPU (EUR) | **${r.current.arpu.toFixed(4)}** | ${r.baseline.arpu.toFixed(4)} |`);
lines.push(`| Ad revenue (EUR) | ${r.current.revenue.toFixed(2)} | ${r.baseline.revenue.toFixed(2)} |`);
lines.push(`| Active users | ${r.current.activeUsers} | — |`);
lines.push("");
lines.push(`**ARPU ratio current/baseline:** ${(r.ratio * 100).toFixed(0)}%`);
if (typeof r.revenueRatio === "number") {
  lines.push(`**Revenue ratio current/baseline:** ${(r.revenueRatio * 100).toFixed(0)}%`);
}
const revenueFloorTxt =
  r.floors && typeof r.floors.revenue === "number"
    ? ` AND revenue < ${(r.floors.revenue * 100).toFixed(0)}% of baseline`
    : "";
const absoluteFloorTxt =
  r.floors && typeof r.floors.absoluteEUR === "number" && r.floors.absoluteEUR > 0
    ? ` OR absolute < ${r.floors.absoluteEUR.toFixed(4)} EUR`
    : "";
lines.push(
  `**Thresholds:** (ARPU ratio < ${(r.floors.ratio * 100).toFixed(0)}%${absoluteFloorTxt})${revenueFloorTxt}`,
);
lines.push("");
lines.push(
  "> This alert fires only when revenue is ALSO down — a low ARPU with healthy revenue is a benign active-user spike (traffic surge, campaign, bot/AI crawl), not lost revenue. Because revenue is confirmed down here, treat it as a real regression and work the checklist below.",
);
lines.push("");
lines.push("### Triggered conditions");
for (const reason of r.reasons || []) {
  lines.push(`- ${reason}`);
}
lines.push("");
if (Array.isArray(r.rows) && r.rows.length > 0) {
  lines.push("### Daily history");
  lines.push("");
  lines.push("| Date | ARPU (EUR) | Revenue (EUR) | Active users |");
  lines.push("|---|---:|---:|---:|");
  for (const row of r.rows) {
    lines.push(`| ${row.date} | ${row.arpu.toFixed(4)} | ${row.revenue.toFixed(2)} | ${row.activeUsers} |`);
  }
  lines.push("");
}
lines.push("### Diagnostic checklist (in priority order)");
lines.push("");
lines.push("1. **RPM canary status** — check the latest run of `rpm-canary.yml`. If it also fired, the cause is upstream AdSense/content (see its own checklist); ARPU inherits any RPM regression proportionally.");
lines.push("2. **Recent deploys** — `gh run list --branch main --limit 20 --workflow=deploy.yml`. A failed `validate-live` around the regression window is the likely trigger.");
lines.push("3. **GA4 real-time / DebugView** — confirm `totalAdRevenue`/`activeUsers` are still reporting correctly and no client instrumentation regressed (see `scripts/user-value-report.mjs` for the GA4 custom-dimension setup this metric depends on).");
lines.push("4. **AdSense console** — Sites tab for ads.txt / policy issues; Performance tab for reach by ad format.");
lines.push("5. **Traffic-source mix** — pull `scripts/user-value-report.mjs --days 14` segmented by acquisition source; a shift toward low-value sources (e.g. bot-heavy referrers) depresses ARPU without a platform incident.");
lines.push("");
lines.push("### Manual rollback (if needed)");
lines.push("");
lines.push("```bash");
lines.push("gh workflow run deploy.yml --ref $(node scripts/deploy-registry.mjs get-good | jq -r .sha)");
lines.push("```");
lines.push("");

process.stdout.write(lines.join("\n"));
