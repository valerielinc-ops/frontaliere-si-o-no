#!/usr/bin/env node
/**
 * check-active-jobs-regression.mjs
 *
 * Anti-regression gate: blocks the deploy when `data/jobs-stats.json`
 * `totals.activeJobs` drops below the baseline by more than the allowed
 * threshold.
 *
 * Why exists: incident 2026-05-21 — silent slice skips dropped active
 * jobs from 5922 → 2603 (-57%). Nothing surfaced until the artifact
 * size was already shipped. Per CLAUDE.md rule #5 (root cause, not
 * workaround) the assemble-jobs hard-fail catches malformed slices,
 * BUT any other source of mass job loss (a crawler bug, an over-eager
 * housekeeping prune, expired-jobs accidentally promoted, etc.) would
 * still slip through. This gate is the second line of defense.
 *
 * Threshold: 25% (configurable via env or CLI). Higher than typical
 * day-over-day churn (~5%) but tight enough to catch a -57% incident.
 *
 * Baseline: data/active-jobs-baseline.json. Auto-bumps when the
 * current count is HIGHER than baseline (ratchet up only — never
 * lowers automatically, per CLAUDE.md rule #1).
 *
 * Usage:
 *   node scripts/check-active-jobs-regression.mjs
 *   node scripts/check-active-jobs-regression.mjs --threshold=0.30
 *   node scripts/check-active-jobs-regression.mjs --rebaseline   # ratchet up baseline (must NOT lower)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STATS_PATH = path.resolve("data/jobs-stats.json");
const BASELINE_PATH = path.resolve("data/active-jobs-baseline.json");
const DEFAULT_THRESHOLD = 0.25;

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const args = { threshold: DEFAULT_THRESHOLD, rebaseline: false };
  for (const a of argv) {
    if (a === "--rebaseline") args.rebaseline = true;
    else if (a.startsWith("--threshold=")) args.threshold = Number(a.split("=")[1]);
  }
  if (process.env.ACTIVE_JOBS_REGRESSION_THRESHOLD) {
    args.threshold = Number(process.env.ACTIVE_JOBS_REGRESSION_THRESHOLD);
  }
  return args;
}

function main() {
  const { threshold, rebaseline } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    console.error(`❌ Invalid threshold: ${threshold} (must be 0 < t < 1)`);
    process.exit(2);
  }

  const stats = readJson(STATS_PATH);
  if (!stats?.totals?.activeJobs) {
    console.error(`❌ ${path.relative(process.cwd(), STATS_PATH)} missing totals.activeJobs`);
    process.exit(2);
  }
  const current = stats.totals.activeJobs;

  const baseline = readJson(BASELINE_PATH);
  if (!baseline?.activeJobs) {
    // First-run bootstrap. Write the baseline and pass through.
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          activeJobs: current,
          updatedAt: new Date().toISOString(),
          note: "bootstrap — first baseline write",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`ℹ️  active-jobs baseline bootstrapped at ${current} jobs.`);
    return;
  }

  const prev = baseline.activeJobs;
  const delta = current - prev;
  const deltaPct = delta / prev;

  if (rebaseline) {
    // Ratchet-up only — refuse to lower the baseline silently (rule #1).
    if (current < prev) {
      console.error(
        `❌ Refusing to rebaseline DOWN: current=${current} < baseline=${prev}. ` +
          `If this drop is intentional (e.g. crawler retired), update the baseline manually with a justification.`,
      );
      process.exit(2);
    }
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          activeJobs: current,
          previousActiveJobs: prev,
          updatedAt: new Date().toISOString(),
          note: "rebaseline (ratchet up)",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✅ active-jobs baseline ratcheted: ${prev} → ${current} (+${(deltaPct * 100).toFixed(1)}%).`);
    return;
  }

  const pctTxt = `${(deltaPct * 100).toFixed(1)}%`;
  console.log(`active jobs: current=${current} baseline=${prev} Δ=${delta} (${pctTxt}), threshold=-${(threshold * 100).toFixed(0)}%`);

  if (deltaPct <= -threshold) {
    console.error(
      `❌ active-jobs regression: dropped ${pctTxt} (>${(threshold * 100).toFixed(0)}% allowed).\n` +
        `   current=${current} baseline=${prev}\n` +
        `   Most likely cause: malformed slices silently dropped, crawler outage, or expired-jobs leak.\n` +
        `   Investigate before deploying. To intentionally lower the baseline, rebaseline + commit with justification.`,
    );
    process.exit(1);
  }

  // Auto-ratchet: if current > baseline, bump it forward so tomorrow's
  // threshold uses the higher floor. This is the "baseline goes DOWN only
  // manually" pattern: it can only INCREASE automatically.
  if (current > prev) {
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          activeJobs: current,
          previousActiveJobs: prev,
          updatedAt: new Date().toISOString(),
          note: "auto-ratchet (current > baseline)",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`📈 baseline auto-ratcheted to ${current}.`);
  } else {
    console.log("✅ within tolerance.");
  }
}

main();
