#!/usr/bin/env node
/**
 * SEO position tracker — REPORT-ONLY (non-blocking).
 *
 * History: this was a deploy GATE that blocked any PR adding a new
 * build-plugin-emitted SEO landing while the 7-day GSC avg position was
 * > THRESHOLD. Owner decision (2026-06-24) DOWNGRADED it from a blocker to a
 * tracker: losing real SEO traffic and serving users 404s (e.g. ~14k/day of
 * indexed `ricerca-stipendio-*` pages going 404) outweighs the avg-position
 * vanity metric. New SEO landings are no longer blocked.
 *
 * What it still does: reads `data/gsc-position-rolling.json` (produced by
 * `scripts/refresh-gsc-position-rolling.mjs`), prints the current 7-day avg
 * position, and — for visibility only — lists any new SEO-landing emitter
 * files added in the PR diff. It NEVER fails the build.
 *
 * Exit code: ALWAYS 0. (Kept as a script, not deleted, so the CI step keeps
 * surfacing the position signal in deploy logs.)
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Informational reference line only — no longer enforced.
const THRESHOLD = 7.5;
const ROLLING = process.env.GSC_ROLLING_FILE || 'data/gsc-position-rolling.json';

function isLandingEmitter(path) {
  // Bridge/redirect emitters collapse URLs — never a new landing surface.
  if (/Bridge/i.test(path) || /Redirect/i.test(path)) return false;
  return /^build-plugins\/.+(Landing[^/]*|Pages|Hub)\.ts$/.test(path);
}

function main() {
  if (!existsSync(ROLLING)) {
    console.log(`ℹ️  SEO position tracking: ${ROLLING} not present — skipping (non-blocking).`);
    return; // exit 0
  }

  let avg;
  try {
    avg = Number(JSON.parse(readFileSync(ROLLING, 'utf8')).avg_position);
  } catch (e) {
    console.log(`ℹ️  SEO position tracking: could not read ${ROLLING} (${e.message}) — skipping.`);
    return; // exit 0
  }

  if (!Number.isFinite(avg)) {
    console.log(`ℹ️  SEO position tracking: avg_position missing/non-numeric — skipping.`);
    return; // exit 0
  }

  const trend = avg <= THRESHOLD ? `at/below ${THRESHOLD} (healthy)` : `above ${THRESHOLD} reference`;
  console.log(`📊 SEO position tracking: 7-day GSC avg position ${avg.toFixed(2)} — ${trend}.`);

  // List any new landing emitters purely for visibility (NOT blocking).
  const base = process.env.GITHUB_BASE_REF || 'main';
  let diff = '';
  try {
    diff = execSync(`git diff --name-status origin/${base}...HEAD`, { encoding: 'utf8' });
  } catch {
    try {
      diff = execSync(`git diff --name-status ${base}...HEAD`, { encoding: 'utf8' });
    } catch {
      /* no git context — skip the diff note */
    }
  }

  const newLandings = diff
    .split('\n')
    .filter((l) => l.startsWith('A\t'))
    .map((l) => l.split('\t')[1])
    .filter((p) => p && isLandingEmitter(p));

  if (newLandings.length) {
    console.log(`📝 New SEO-landing emitter(s) in this PR (allowed — tracking only):`);
    for (const p of newLandings) console.log(`   + ${p}`);
  }
  // Always succeed — tracking, not gating.
}

main();
