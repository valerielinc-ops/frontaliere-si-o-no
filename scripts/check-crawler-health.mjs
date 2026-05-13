#!/usr/bin/env node
/**
 * Crawler health checker.
 *
 * Reads `data/jobs/by-crawler/{slug}.json`, derives per-crawler health, updates
 * `data/crawler-health.json` (running state), and writes
 * `data/crawler-health-issues.json` if any crawler is stale/broken.
 *
 * Exit code:
 *   0 — all crawlers healthy (or no crawlers at all)
 *   1 — one or more crawlers stale/broken (workflow will open issues)
 *
 * Safe to run multiple times per day. Does NOT throw on individual crawler
 * read errors — logs and continues.
 *
 * Reads only `data/jobs/by-crawler/` (not the deprecated `data/jobs.json`).
 *
 * Freshness signal: each by-crawler slice carries `assembledAt` (set by the
 * crawler when it writes the slice). We trust this over file mtime because
 * mtime is unreliable on CI checkouts (always equals checkout time, not the
 * upstream commit time of the file). The slice's `assembledAt` is what the
 * crawler wrote on its last successful run.
 *
 * Status transitions:
 *   - healthy           → slice fresh (<= 7d) AND (jobs > 0 OR low empty streak)
 *   - broken            → 3+ consecutive empty observations (legitimately
 *                         empty source like BancaStato won't cross this gate
 *                         because the daily monitor records the same fresh
 *                         slice repeatedly — see consecutiveEmptyRuns logic)
 *   - stale             → slice `assembledAt` older than 7d
 *   - warming_up        → never observed before, slice is fresh and empty
 *                         (do NOT flag — wait until we have history)
 *
 * Follow-up (not in this script): adding `lastFetchOutcome` to each summary
 * slice — values like "ok" / "anti_bot_block" / "selector_miss" /
 * "filtered_empty" — would let the monitor distinguish a fetch failure from
 * a legitimately empty source on the FIRST observation, rather than waiting
 * 3 days for the empty-streak gate.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const HEALTH_STATE_PATH = path.join(ROOT, 'data', 'crawler-health.json');
const HEALTH_ISSUES_PATH = path.join(ROOT, 'data', 'crawler-health-issues.json');

const STALE_AFTER_DAYS = 7;
const BROKEN_AFTER_EMPTY_RUNS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Read JSON file, return null on any error. */
async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** List `*.json` files in by-crawler dir, return slugs. */
async function listCrawlerSlugs() {
  try {
    const entries = await fs.readdir(BY_CRAWLER_DIR);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
  } catch (err) {
    console.error(`[health] Cannot read ${BY_CRAWLER_DIR}: ${err.message}`);
    return [];
  }
}

/**
 * Inspect one crawler's by-crawler slice and return derived facts.
 *
 * Returns null if the file cannot be read or parsed (caller logs + skips).
 * Returns `{ slug, assembledAt, jobCount }` otherwise.
 *
 * `assembledAt` is the slice's self-reported write time — far more reliable
 * than `fs.stat().mtime` on CI checkouts.
 */
async function inspectCrawler(slug) {
  const filePath = path.join(BY_CRAWLER_DIR, `${slug}.json`);
  const data = await readJsonSafe(filePath);
  if (data === null) {
    console.warn(`[health] ${slug}: cannot read/parse slice; skipping`);
    return null;
  }

  // Tolerate any shape: array of jobs OR { jobs: [...] } OR { entries: [...] }.
  let jobCount = 0;
  if (Array.isArray(data)) {
    jobCount = data.length;
  } else if (data && Array.isArray(data.jobs)) {
    jobCount = data.jobs.length;
  } else if (data && Array.isArray(data.entries)) {
    jobCount = data.entries.length;
  } else if (data && typeof data === 'object') {
    // Best-effort: count any array property at the top level.
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length > jobCount) jobCount = v.length;
    }
  }

  // Slice shape is `{ crawlerKey, assembledAt, jobs }`. Fall back to file mtime
  // only as a last resort (slice format predates `assembledAt` for a handful of
  // very old shapes).
  let assembledAt =
    data && typeof data === 'object' && typeof data.assembledAt === 'string'
      ? data.assembledAt
      : null;

  if (!assembledAt) {
    try {
      const stat = await fs.stat(filePath);
      assembledAt = stat.mtime.toISOString();
    } catch {
      assembledAt = null;
    }
  }

  return { slug, assembledAt, jobCount };
}

/**
 * Compose new state for a crawler, given previous state + new observation.
 *
 * Status priority (first match wins):
 *   1. slice `assembledAt` older than 7d → "stale" (regardless of streak)
 *   2. 3+ consecutive empty observations → "broken"
 *   3. fresh + empty + no prior non-zero ever → "warming_up" (do NOT flag)
 *   4. otherwise → "healthy"
 */
function nextCrawlerState(prev, observation, nowIso, nowMs) {
  const previous = prev && typeof prev === 'object' ? prev : {};
  const hadPriorState = Boolean(prev);
  const lastObservedJobs = observation.jobCount;

  const consecutiveEmptyRuns =
    lastObservedJobs > 0 ? 0 : (previous.consecutiveEmptyRuns ?? 0) + 1;

  const lastNonZeroJobs =
    lastObservedJobs > 0 ? lastObservedJobs : (previous.lastNonZeroJobs ?? 0);

  // "Successful" = slice carries non-zero jobs. We use `assembledAt` rather
  // than file mtime so the timestamp survives CI checkouts cleanly.
  const lastSuccessfulRunAt =
    lastObservedJobs > 0
      ? observation.assembledAt
      : (previous.lastSuccessfulRunAt ?? null);

  // Freshness derives from the slice's own `assembledAt`, NOT from
  // `lastSuccessfulRunAt`. A source like BancaStato may legitimately be empty
  // for weeks — the slice is still being refreshed daily, so the crawler is
  // working. Only flag stale when the slice itself stops being written.
  const sliceAgeMs =
    observation.assembledAt !== null
      ? nowMs - new Date(observation.assembledAt).getTime()
      : Infinity;
  const sliceAgeDays = sliceAgeMs / MS_PER_DAY;

  let status = 'healthy';
  let reason = null;

  if (sliceAgeDays > STALE_AFTER_DAYS) {
    status = 'stale';
    reason = `slice not updated in ${Math.round(sliceAgeDays)} days (assembledAt=${observation.assembledAt ?? 'unknown'})`;
  } else if (consecutiveEmptyRuns >= BROKEN_AFTER_EMPTY_RUNS) {
    status = 'broken';
    reason = `${consecutiveEmptyRuns} consecutive runs returned 0 jobs`;
  } else if (lastObservedJobs === 0 && !lastSuccessfulRunAt && !hadPriorState) {
    // First time we see this crawler AND it's empty AND we have no history.
    // We can't tell yet if this is a legitimately-empty source (BancaStato)
    // or a freshly-broken parser. Wait for the empty-streak gate to catch
    // genuinely broken parsers — they'll fail 3 days in a row.
    status = 'warming_up';
    reason = null;
  }

  return {
    state: {
      lastSuccessfulRunAt,
      lastNonZeroJobs,
      consecutiveEmptyRuns,
      lastFailureReason: reason,
      status,
      _lastObservedAt: nowIso,
      _lastObservedJobs: lastObservedJobs,
      _lastObservedAssembledAt: observation.assembledAt,
    },
    reason,
    status,
  };
}

async function main() {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const slugs = await listCrawlerSlugs();
  if (slugs.length === 0) {
    console.warn('[health] No crawler files found; nothing to check.');
  }

  const prevState = (await readJsonSafe(HEALTH_STATE_PATH)) ?? {
    _lastCheckedAt: null,
    crawlers: {},
  };
  const prevCrawlers = prevState.crawlers ?? {};

  const nextCrawlers = {};
  const issues = [];

  for (const slug of slugs) {
    const observation = await inspectCrawler(slug);
    if (!observation) continue; // Skipped — already logged.

    const { state, status, reason } = nextCrawlerState(
      prevCrawlers[slug],
      observation,
      nowIso,
      nowMs,
    );
    nextCrawlers[slug] = state;

    if (status === 'stale' || status === 'broken') {
      issues.push({
        slug,
        reason: reason ?? `status=${status}`,
        lastSeenAt: state.lastSuccessfulRunAt,
        status,
        consecutiveEmptyRuns: state.consecutiveEmptyRuns,
      });
    }
  }

  // Carry forward any previously-tracked crawlers that disappeared from disk
  // (e.g. crawler renamed) so we don't lose their history silently.
  for (const [slug, prev] of Object.entries(prevCrawlers)) {
    if (!(slug in nextCrawlers)) {
      nextCrawlers[slug] = { ...prev, status: 'unknown', _missingAt: nowIso };
    }
  }

  const nextState = {
    _lastCheckedAt: nowIso,
    crawlers: nextCrawlers,
  };

  await fs.writeFile(HEALTH_STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');

  if (issues.length > 0) {
    await fs.writeFile(HEALTH_ISSUES_PATH, JSON.stringify(issues, null, 2) + '\n');
    console.error(
      `[health] ${issues.length} crawler(s) stale/broken:`,
      issues.map((i) => `${i.slug}(${i.status})`).join(', '),
    );
    process.exit(1);
  }

  // Clear the stale issues file if it exists from a prior run — nothing to flag.
  try {
    await fs.unlink(HEALTH_ISSUES_PATH);
  } catch {
    /* file did not exist */
  }

  console.log(`[health] All ${slugs.length} crawler(s) healthy.`);
  process.exit(0);
}

// Exported for tests. `main()` only runs when the script is invoked directly.
export { nextCrawlerState, inspectCrawler };

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(path.basename(process.argv[1] || ''));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('[health] Fatal error:', err);
    process.exit(2);
  });
}
