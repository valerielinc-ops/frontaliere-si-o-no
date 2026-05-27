#!/usr/bin/env node
/**
 * SEO moratorium gate — enforces CLAUDE.md non-negotiable rule #19.
 *
 * Reads `data/gsc-position-rolling.json` (produced by
 * `scripts/refresh-gsc-position-rolling.mjs`). If the 7-day avg position
 * is > THRESHOLD, BLOCKS any PR that adds a new build-plugin-emitted
 * SEO landing emitter (file matching `build-plugins/*Landing*.ts`,
 * `*Pages.ts`, `*Hub.ts`).
 *
 * Exempt — even during moratorium:
 *   - Modifications to existing files (only ADDITIONS are blocked)
 *   - Files containing "JobOrphanBridge" (redirect/bridge emitters)
 *   - Files containing "Bridge" (URL-bridge emitters)
 *   - Files containing "Redirect"
 *
 * The rule body itself also exempts:
 *   - bug fixes to existing landings (these don't add new files → not caught)
 *   - consolidation refactors that NET-REDUCE page count (manual judgement)
 *
 * Exit codes:
 *   0 — moratorium not active, OR active but no forbidden additions
 *   1 — moratorium active AND PR adds a new SEO landing emitter
 *   2 — internal error (missing data file, missing git context)
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const THRESHOLD = 7.5;
const ROLLING = process.env.GSC_ROLLING_FILE || 'data/gsc-position-rolling.json';

function isExemptPath(path) {
  // Bridge/redirect emitters: never new landings — they collapse URLs
  if (/Bridge/i.test(path)) return true;
  if (/Redirect/i.test(path)) return true;
  return false;
}

function matchesLandingPattern(path) {
  return /^build-plugins\/.+(Landing[^/]*|Pages|Hub)\.ts$/.test(path);
}

function main() {
  if (!existsSync(ROLLING)) {
    console.error(`Missing ${ROLLING}. Run scripts/refresh-gsc-position-rolling.mjs first.`);
    process.exit(2);
  }

  const rolling = JSON.parse(readFileSync(ROLLING, 'utf8'));
  const avg = Number(rolling.avg_position);
  if (!Number.isFinite(avg)) {
    console.error(`Malformed ${ROLLING}: avg_position is not a number.`);
    process.exit(2);
  }

  if (avg <= THRESHOLD) {
    console.log(`Moratorium not active: avg_position ${avg.toFixed(2)} ≤ ${THRESHOLD}`);
    process.exit(0);
  }

  // Moratorium active — inspect the diff
  const base = process.env.GITHUB_BASE_REF || 'main';
  let diff;
  try {
    diff = execSync(`git diff --name-status origin/${base}...HEAD`, { encoding: 'utf8' });
  } catch (e) {
    // Fallback: try without origin/ prefix (local runs without remote)
    try {
      diff = execSync(`git diff --name-status ${base}...HEAD`, { encoding: 'utf8' });
    } catch (e2) {
      console.error(`Unable to compute git diff against ${base}: ${e2.message}`);
      process.exit(2);
    }
  }

  const forbidden = diff.split('\n').filter((line) => {
    if (!line.startsWith('A\t')) return false; // ADDITIONS only
    const path = line.split('\t')[1];
    if (!path) return false;
    if (!matchesLandingPattern(path)) return false;
    if (isExemptPath(path)) return false;
    return true;
  });

  if (forbidden.length === 0) {
    console.log(
      `Moratorium active (avg position ${avg.toFixed(2)} > ${THRESHOLD}) ` +
      `but no new SEO landing emitters added — OK.`,
    );
    process.exit(0);
  }

  console.error(
    `Moratorium active (avg position ${avg.toFixed(2)} > ${THRESHOLD}). ` +
    `The following new SEO-landing files are blocked:`,
  );
  for (const line of forbidden) {
    console.error(`  ${line}`);
  }
  console.error('');
  console.error('Per CLAUDE.md rule #19, NO new build-plugin-emitted SEO landings may');
  console.error('be merged while the 7-day GSC avg position > 7.5. Exceptions: bug');
  console.error('fixes to existing landings, consolidation refactors that NET-REDUCE');
  console.error('page count, redirect/bridge emitters, JobOrphanBridge variants.');
  process.exit(1);
}

main();
