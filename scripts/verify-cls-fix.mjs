#!/usr/bin/env node
/**
 * verify-cls-fix.mjs — one-shot post-deploy CLS verification harness.
 *
 * Runs both CLS measurement layers in sequence and prints a single verdict:
 *   1. PSI lab via audit-cls-live.mjs (ratchet vs data/cls-baseline.json).
 *   2. Playwright DOM probe via audit-cls-stripping.mjs (verifies our
 *      reservation is preserved, captures Auto Ads injection state).
 *
 * Both are read-only — they hit the live site and never write to AdSense.
 *
 * Use this after every CLS-related deploy:
 *   node scripts/verify-cls-fix.mjs
 *
 * It exits 0 if everything looks good (no hard CLS regression, no min-height
 * stripping, Auto Ads injecting where expected).
 *
 * Auth: PAGESPEED_API_KEY (loaded by load-rc-env). No auth needed for the
 * Playwright leg.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function header(label) {
  console.log('\n' + '─'.repeat(80));
  console.log(label);
  console.log('─'.repeat(80));
}

function run(label, cmd, args, opts = {}) {
  header(label);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  return r.status === 0;
}

let allGreen = true;

// 1) Lab CLS via audit-cls-live (ratchet)
const labOk = run('① PSI lab CLS — ratchet vs data/cls-baseline.json', 'node', [
  'scripts/audit-cls-live.mjs',
  '--strategy=mobile',
]);
if (!labOk) allGreen = false;

// 2) DOM probe via audit-cls-stripping
const stripOk = run('② DOM probe — adsbygoogle reservations + Auto Ads state', 'node', [
  'scripts/audit-cls-stripping.mjs',
]);
if (!stripOk) allGreen = false;

// 3) Latest cls-{date}.json report — surface the headline numbers
header('③ Headline CLS by URL (latest report)');
const today = new Date().toISOString().split('T')[0];
const reportPath = resolve(ROOT, `reports/cls-${today}.json`);
if (existsSync(reportPath)) {
  try {
    const j = JSON.parse(readFileSync(reportPath, 'utf-8'));
    for (const r of j.results || []) {
      const tag =
        r.verdict?.state === 'hard_regression' ? '🔴' :
        r.verdict?.state === 'soft_regression' ? '⚠️' :
        r.verdict?.state === 'improved' ? '✅' :
        r.verdict?.state === 'flat' ? '·' :
        r.verdict?.state === 'new' ? '🆕' : '?';
      console.log(`${tag} ${r.key.padEnd(40)} cls=${(r.effective ?? 0).toFixed(3)}  baseline=${r.baseline != null ? r.baseline.toFixed(3) : 'n/a'}  ${r.verdict?.reason || ''}`);
    }
    console.log(`\nhard regressions: ${j.hardRegressions ?? 0}  ·  soft: ${j.softRegressions ?? 0}  ·  errors: ${j.errors?.length ?? 0}`);
  } catch (e) {
    console.error('Failed to parse latest cls report:', e.message);
  }
} else {
  console.log(`(no report yet at ${reportPath})`);
}

console.log('\n' + (allGreen ? '✅ verify-cls-fix: all checks green' : '🔴 verify-cls-fix: at least one check failed'));
process.exit(allGreen ? 0 : 1);
