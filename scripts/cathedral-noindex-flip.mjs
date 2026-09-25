#!/usr/bin/env node
/**
 * cathedral-noindex-flip.mjs — one-way ratchet for noindex→index canton flips.
 *
 * Context (CLAUDE.md non-negotiables #1, #4, #14 + docs/CATHEDRAL-STATUS.md item #4):
 *
 *   The cathedral CH-wide expansion (PRs #54-60) emitted 104 canton hub pages
 *   and 144 F4/F5 per-canton snapshot/employer pages, all initially
 *   `noindex,follow`. After 7-14 days of data accumulation, the per-canton
 *   shard `data/jobs-by-canton/{CODE}.json` may contain ≥ MIN_JOBS_FOR_CANTON_PAGE
 *   (= 5) canonical JobPosting entries (jobs that are NOT marked `redirect:true`
 *   or `expired:true`). When that threshold is crossed, the page deserves
 *   `index,follow`.
 *
 *   The `jobsSeoPagesPlugin.ts` build emitter ALREADY consults the live shard
 *   count and chooses `index,follow` vs `noindex,follow` per canton hub. The
 *   F4/F5 per-canton CH plugins (`jobMarketSnapshotChCantonPages.ts`,
 *   `weeklyEmployersChCantonPages.ts`) currently hardcode `noindex,follow`.
 *
 *   This script is the orchestration layer that:
 *     1. Walks every canton shard + computes the canonical-job count.
 *     2. For every (canton, locale, page-kind) that newly crosses threshold,
 *        appends a flip event to `data/cathedral-flip-log.json`.
 *     3. The log is APPEND-ONLY and acts as a one-way ratchet: once a URL is
 *        logged, the workflow will never log a reverse flip. Future builds
 *        consume the log to keep flipped URLs index,follow (downstream code
 *        change tracked separately; the log is the contract).
 *
 *   When run with --dry-run (default true for safety), no log mutation is
 *   performed — the planned flips are printed to stdout for review.
 *
 *   The workflow then commits the updated log and pushes to main, which
 *   triggers `deploy.yml` to rebuild with the now-eligible robots meta.
 *
 * CLI:
 *   node scripts/cathedral-noindex-flip.mjs --dry-run        # default
 *   node scripts/cathedral-noindex-flip.mjs --no-dry-run     # mutate log
 *   node scripts/cathedral-noindex-flip.mjs --threshold=5    # override
 *
 * Exit codes:
 *   0 — completed (with or without new flips)
 *   1 — runtime error (bad shard, malformed log, etc.)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCantonUrlSlugs } from './lib/canton-url-slugs.mjs';
import {
  AGGREGATE_KEY,
  loadCantonJobs,
} from './lib/jobs-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const FLIP_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'cathedral-flip-log.json');
const DEFAULT_THRESHOLD = 5;
const BASE_URL = 'https://frontaliereticino.ch';

/** Locales emitted by the cathedral build. */
const LOCALES = /** @type {const} */ (['it', 'en', 'de', 'fr']);

/** Section prefix per locale (canton hub URL: `/{prefix}-{slug}/`). */
const SECTION_PREFIX_BY_LOCALE = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-in',
  fr: 'trouver-emploi',
};

/** Snapshot path segment per locale (F4 page-kind). */
const SNAPSHOT_SEGMENT_BY_LOCALE = {
  it: 'mercato-del-lavoro',
  en: 'job-market',
  de: 'arbeitsmarkt',
  fr: 'marche-du-travail',
};

/** Employers path segment per locale (F5 page-kind). */
const EMPLOYERS_SEGMENT_BY_LOCALE = {
  it: 'aziende-che-assumono',
  en: 'employers-hiring',
  de: 'arbeitgeber-die-einstellen',
  fr: 'employeurs-qui-recrutent',
};

/**
 * Argument parser for `--key=value` / `--flag` / `--no-flag` style.
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, threshold: number }}
 */
function parseArgs(argv) {
  let dryRun = true; // safe default
  let threshold = DEFAULT_THRESHOLD;

  for (const arg of argv.slice(2)) {
    if (arg === '--no-dry-run' || arg === '--apply') {
      dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--threshold=')) {
      const n = Number(arg.slice('--threshold='.length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid --threshold value: "${arg}"`);
      }
      threshold = n;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: cathedral-noindex-flip.mjs [--dry-run|--no-dry-run] [--threshold=N]');
      process.exit(0);
    }
  }

  return { dryRun, threshold };
}

/**
 * Count canonical jobs in a canton shard (excludes redirects + expired).
 * @param {string} cantonCode
 * @returns {Promise<number>}
 */
async function countCanonicalJobs(cantonCode) {
  const jobs = await loadCantonJobs(cantonCode);
  let count = 0;
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const j = /** @type {Record<string, unknown>} */ (job);
    if (j.redirect === true) continue;
    if (j.expired === true) continue;
    count += 1;
  }
  return count;
}

/**
 * Build the URL for a (canton, locale, kind) triple.
 *
 * @param {string} cantonCode
 * @param {'it'|'en'|'de'|'fr'} locale
 * @param {'hub'|'snapshot'|'employers'} kind
 * @param {Record<string, Record<string, string>>} cantons
 * @param {Record<string, string>} aggregate
 * @returns {string|null} Full URL or null if slug missing.
 */
function buildPageUrl(cantonCode, locale, kind, cantons, aggregate) {
  const slug =
    cantonCode === AGGREGATE_KEY
      ? aggregate[locale]
      : cantons[cantonCode]?.[locale];
  if (!slug) return null;

  const localePrefix = locale === 'it' ? '' : `/${locale}`;
  const sectionPrefix = SECTION_PREFIX_BY_LOCALE[locale];
  const cantonSection = `${sectionPrefix}-${slug}`;

  switch (kind) {
    case 'hub':
      return `${BASE_URL}${localePrefix}/${cantonSection}/`;
    case 'snapshot':
      return `${BASE_URL}${localePrefix}/${cantonSection}/${SNAPSHOT_SEGMENT_BY_LOCALE[locale]}/`;
    case 'employers':
      return `${BASE_URL}${localePrefix}/${cantonSection}/${EMPLOYERS_SEGMENT_BY_LOCALE[locale]}/`;
    default:
      return null;
  }
}

/**
 * @typedef {Object} FlipEvent
 * @property {string} url
 * @property {string} canton
 * @property {'it'|'en'|'de'|'fr'} locale
 * @property {'hub'|'snapshot'|'employers'} kind
 * @property {number} jobsCount
 * @property {string} flippedAt        ISO timestamp
 * @property {number} threshold
 */

/**
 * @typedef {Object} FlipLog
 * @property {string} _comment
 * @property {number} version
 * @property {string} lastUpdated
 * @property {FlipEvent[]} flips
 */

/**
 * Load the flip log, or return a fresh empty log if missing/empty.
 * @returns {Promise<FlipLog>}
 */
async function loadFlipLog() {
  /** @type {string|null} */
  let raw = null;
  try {
    raw = await fs.readFile(FLIP_LOG_PATH, 'utf8');
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code !== 'ENOENT') throw err;
  }
  if (!raw || raw.trim().length === 0) {
    return emptyLog();
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.flips)) {
    throw new Error(
      `[cathedral-noindex-flip] ${FLIP_LOG_PATH} has unexpected shape; refusing to mutate. ` +
        `Inspect and reset manually.`,
    );
  }
  return /** @type {FlipLog} */ (parsed);
}

/** @returns {FlipLog} */
function emptyLog() {
  return {
    _comment:
      'Append-only one-way ratchet: every entry records when a cathedral page ' +
      'crossed MIN_JOBS_FOR_CANTON_PAGE and became eligible for index,follow. ' +
      'Maintained by .github/workflows/cathedral-noindex-flip.yml. Do not edit ' +
      'by hand. Removing entries is forbidden (CLAUDE.md non-negotiables #1, #5).',
    version: 1,
    lastUpdated: new Date().toISOString(),
    flips: [],
  };
}

/**
 * Index existing flip URLs for fast "already flipped?" lookup.
 * @param {FlipLog} log
 * @returns {Set<string>}
 */
function indexFlippedUrls(log) {
  const seen = new Set();
  for (const f of log.flips) {
    if (f && typeof f.url === 'string') seen.add(f.url);
  }
  return seen;
}

/**
 * Write the flip log atomically (temp file + rename).
 * @param {FlipLog} log
 */
async function writeFlipLog(log) {
  const tmp = `${FLIP_LOG_PATH}.tmp-${process.pid}`;
  const out = {
    ...log,
    lastUpdated: new Date().toISOString(),
  };
  const json = `${JSON.stringify(out, null, 2)}\n`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, FLIP_LOG_PATH);
}

/**
 * Compute every candidate flip across cantons + locales + kinds.
 *
 * @param {number} threshold
 * @returns {Promise<{ candidates: FlipEvent[], countsByCanton: Map<string, number> }>}
 */
async function computeCandidates(threshold) {
  const { cantons, aggregate } = loadCantonUrlSlugs();
  /** @type {FlipEvent[]} */
  const candidates = [];
  /** @type {Map<string, number>} */
  const countsByCanton = new Map();
  const now = new Date().toISOString();

  // The aggregator is always indexable per the build emitter (always
  // index,follow). We DO NOT log it: there is no flip to perform.
  // We iterate every real canton (skip TI — owned by legacy pipeline).
  const cantonCodes = Object.keys(cantons).filter((c) => c !== 'TI');

  for (const cantonCode of cantonCodes) {
    const count = await countCanonicalJobs(cantonCode);
    countsByCanton.set(cantonCode, count);
    if (count < threshold) continue;

    for (const locale of LOCALES) {
      for (const kind of /** @type {const} */ (['hub', 'snapshot', 'employers'])) {
        const url = buildPageUrl(cantonCode, locale, kind, cantons, aggregate);
        if (!url) continue;
        candidates.push({
          url,
          canton: cantonCode,
          locale,
          kind,
          jobsCount: count,
          flippedAt: now,
          threshold,
        });
      }
    }
  }

  return { candidates, countsByCanton };
}

/**
 * Produce a stable, deterministic ordering for log entries.
 * @param {FlipEvent} a
 * @param {FlipEvent} b
 */
function sortFlips(a, b) {
  if (a.canton !== b.canton) return a.canton.localeCompare(b.canton);
  if (a.locale !== b.locale) return a.locale.localeCompare(b.locale);
  return a.kind.localeCompare(b.kind);
}

/** Main entry point. */
async function main() {
  const { dryRun, threshold } = parseArgs(process.argv);

  console.log(`[cathedral-noindex-flip] mode=${dryRun ? 'DRY-RUN' : 'APPLY'} threshold=${threshold}`);

  const log = await loadFlipLog();
  const alreadyFlipped = indexFlippedUrls(log);
  console.log(
    `[cathedral-noindex-flip] existing flip-log entries: ${alreadyFlipped.size}`,
  );

  const { candidates, countsByCanton } = await computeCandidates(threshold);
  console.log(
    `[cathedral-noindex-flip] cantons evaluated: ${countsByCanton.size}; ` +
      `eligible candidate URLs (≥ ${threshold} jobs): ${candidates.length}`,
  );

  const newFlips = candidates.filter((c) => !alreadyFlipped.has(c.url));
  newFlips.sort(sortFlips);

  if (newFlips.length === 0) {
    console.log('[cathedral-noindex-flip] no new flips this run.');
    if (dryRun) console.log('[cathedral-noindex-flip] (dry-run; no log changes.)');
    return;
  }

  console.log(`[cathedral-noindex-flip] new flips to record: ${newFlips.length}`);
  for (const f of newFlips) {
    console.log(
      `  + ${f.canton} ${f.locale}/${f.kind.padEnd(9)} jobs=${f.jobsCount}  ${f.url}`,
    );
  }

  if (dryRun) {
    console.log('[cathedral-noindex-flip] dry-run complete — no log mutation.');
    return;
  }

  // APPLY: append to log, sort by canton+locale+kind, rewrite atomically.
  const merged = [...log.flips, ...newFlips];
  // Defensive de-dupe (paranoia, since we already filtered).
  /** @type {Map<string, FlipEvent>} */
  const byUrl = new Map();
  for (const f of merged) {
    if (!byUrl.has(f.url)) byUrl.set(f.url, f);
  }
  const finalFlips = Array.from(byUrl.values()).sort(sortFlips);

  /** @type {FlipLog} */
  const next = {
    ...log,
    flips: finalFlips,
  };
  await writeFlipLog(next);
  console.log(
    `[cathedral-noindex-flip] wrote ${FLIP_LOG_PATH} ` +
      `(total entries: ${finalFlips.length})`,
  );
}

main().catch((err) => {
  console.error('[cathedral-noindex-flip] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
