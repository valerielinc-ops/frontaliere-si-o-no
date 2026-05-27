#!/usr/bin/env node
/**
 * backfill-needs-retranslation.mjs
 *
 * One-shot mutator: scans every `data/jobs/by-crawler/<key>.json` slice file and
 * flags legacy locale-incomplete jobs with `needsRetranslation: true` so the
 * `translate-pending-jobs.yml` cron will re-fill the missing locales on the
 * next pass.
 *
 * Background: jobs crawled before the `needsRetranslation` convention was
 * standardised (Fielmann + ~20 other parsers) sit in the slice files with
 * content only in their `sourceLang` locale (e.g. only the `de` slot for
 * Coop-Ticino-locale-cache cached postings). Without the flag, the daily
 * translate cron skips them and they stay locale-incomplete forever.
 *
 * Detection criteria (default mode — `only-source-lang`):
 *   - `job.needsRetranslation` is falsy AND
 *   - the only locale with non-empty content in BOTH
 *       `titleByLocale[locale]` AND `descriptionByLocale[locale]`
 *     is exactly `job.sourceLang` (defaulting to `it` when unset).
 *
 * Broader mode (`--mode=missing-any-locale`): flag any job that is missing
 * content in at least one of the four target locales. Use only when the
 * default backfill has been drained and `translate-pending` still has spare
 * capacity. Recommended to run the default mode first.
 *
 * Default execution is DRY-RUN. Pass `--write` to mutate slice files.
 *
 * Usage:
 *   node scripts/backfill-needs-retranslation.mjs               # dry-run
 *   node scripts/backfill-needs-retranslation.mjs --write       # commit changes
 *   node scripts/backfill-needs-retranslation.mjs --mode=missing-any-locale
 *
 * Output:
 *   - per-company touched count (top by volume)
 *   - total jobs scanned, total touched, total already-flagged
 *
 * Constraints:
 *   - Touches ONLY `data/jobs/by-crawler/*.json` (committed source of truth).
 *   - Never touches `data/jobs.json` (gitignored, materialised by assemble).
 *   - Never edits any other source file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

const LOCALES = ['it', 'en', 'de', 'fr'];

/** Parse CLI flags into a plain object. */
function parseArgs(argv) {
  const args = { write: false, mode: 'only-source-lang', help: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--write') args.write = true;
    else if (raw === '--dry-run') args.write = false;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length);
    else throw new Error(`Unknown flag: ${raw}`);
  }
  if (!['only-source-lang', 'missing-any-locale'].includes(args.mode)) {
    throw new Error(`Unknown --mode value: ${args.mode}`);
  }
  return args;
}

/** Returns the array of locales that have non-empty title AND description. */
function presentLocales(job) {
  const titles = job.titleByLocale || {};
  const descs = job.descriptionByLocale || {};
  return LOCALES.filter(
    (l) =>
      String(titles[l] || '').trim().length > 0 &&
      String(descs[l] || '').trim().length > 0,
  );
}

/**
 * Decide whether a job needs the backfill flag set, based on the requested
 * detection mode.
 */
function shouldFlag(job, mode) {
  if (job.needsRetranslation) return false;
  const present = presentLocales(job);
  if (mode === 'missing-any-locale') {
    return present.length < LOCALES.length;
  }
  // only-source-lang: present === exactly { sourceLang }
  const sl = job.sourceLang || 'it';
  return present.length === 1 && present[0] === sl;
}

function printHelp() {
  console.log(`Usage:
  node scripts/backfill-needs-retranslation.mjs               # dry-run (default)
  node scripts/backfill-needs-retranslation.mjs --write       # mutate slice files
  node scripts/backfill-needs-retranslation.mjs --mode=missing-any-locale
  node scripts/backfill-needs-retranslation.mjs -h

Default mode: only-source-lang
  Flag jobs whose only populated locale matches sourceLang (typical legacy
  Fielmann/coop-ticino-locale-cache case).

Mode: missing-any-locale
  Flag jobs missing at least one of the 4 target locales. Broader; use only
  after the default backfill has drained.

This script never touches data/jobs.json (gitignored) and never edits any
other file outside data/jobs/by-crawler/.
`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(SLICES_DIR)) {
    console.error(`Slice directory not found: ${SLICES_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(SLICES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  let totalJobs = 0;
  let totalAlreadyFlagged = 0;
  let totalTouched = 0;
  let slicesChanged = 0;
  const touchedByCompany = new Map();

  for (const f of files) {
    const fp = path.join(SLICES_DIR, f);
    let raw;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch (err) {
      console.error(`! read failed for ${f}: ${err.message}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error(`! JSON parse failed for ${f}: ${err.message}`);
      continue;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [];
    const crawlerKey = (data && data.crawlerKey) || f.replace(/\.json$/, '');

    let touchedInSlice = 0;
    for (const job of list) {
      totalJobs++;
      if (job.needsRetranslation) {
        totalAlreadyFlagged++;
        continue;
      }
      if (shouldFlag(job, args.mode)) {
        job.needsRetranslation = true;
        touchedInSlice++;
        totalTouched++;
      }
    }

    if (touchedInSlice > 0) {
      touchedByCompany.set(crawlerKey, touchedInSlice);
      slicesChanged++;
      if (args.write) {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────
  const banner = args.write ? '[WRITE]' : '[DRY-RUN]';
  console.log(`${banner} backfill-needs-retranslation (mode=${args.mode})`);
  console.log('');
  console.log(`Slice files scanned        : ${files.length}`);
  console.log(`Total jobs scanned         : ${totalJobs}`);
  console.log(`Already flagged (skipped)  : ${totalAlreadyFlagged}`);
  console.log(`${args.write ? 'Flagged  ' : 'Would flag'}                : ${totalTouched}`);
  console.log(`Slices ${args.write ? 'rewritten' : 'to rewrite'}          : ${slicesChanged}`);

  if (touchedByCompany.size > 0) {
    const sorted = [...touchedByCompany.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 20);
    console.log('');
    console.log(`Top ${top.length} companies by touched count:`);
    for (const [k, v] of top) {
      console.log(`  ${v.toString().padStart(5)}  ${k}`);
    }
    if (sorted.length > top.length) {
      console.log(`  …and ${sorted.length - top.length} more crawlers with smaller touched counts.`);
    }
  } else {
    console.log('');
    console.log('No jobs matched the criteria — nothing to flag.');
  }

  if (!args.write && totalTouched > 0) {
    console.log('');
    console.log('Re-run with --write to commit these changes to slice files.');
  }
}

main();
