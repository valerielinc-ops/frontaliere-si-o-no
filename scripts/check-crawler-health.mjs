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
 * Inspect one crawler's by-crawler file and return derived facts.
 * Returns null if the file cannot be read or parsed (caller logs + skips).
 */
async function inspectCrawler(slug) {
  const filePath = path.join(BY_CRAWLER_DIR, `${slug}.json`);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    console.warn(`[health] ${slug}: cannot stat (${err.code}); skipping`);
    return null;
  }
  const lastModifiedAt = stat.mtime.toISOString();

  const data = await readJsonSafe(filePath);
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

  return { slug, lastModifiedAt, jobCount };
}

/** Compose new state for a crawler, given previous state + new observation. */
function nextCrawlerState(prev, observation, nowIso) {
  const previous = prev && typeof prev === 'object' ? prev : {};
  const lastObservedJobs = observation.jobCount;
  const consecutiveEmptyRuns =
    lastObservedJobs > 0 ? 0 : (previous.consecutiveEmptyRuns ?? 0) + 1;

  const lastNonZeroJobs =
    lastObservedJobs > 0 ? lastObservedJobs : (previous.lastNonZeroJobs ?? 0);

  // Treat "successful" as: file modified AND has non-zero jobs.
  const lastSuccessfulRunAt =
    lastObservedJobs > 0
      ? observation.lastModifiedAt
      : (previous.lastSuccessfulRunAt ?? null);

  const ageMs = lastSuccessfulRunAt
    ? Date.now() - new Date(lastSuccessfulRunAt).getTime()
    : Infinity;
  const ageDays = ageMs / MS_PER_DAY;

  let status = 'healthy';
  let reason = null;
  if (consecutiveEmptyRuns >= BROKEN_AFTER_EMPTY_RUNS) {
    status = 'broken';
    reason = `${consecutiveEmptyRuns} consecutive runs returned 0 jobs`;
  } else if (ageDays > STALE_AFTER_DAYS) {
    status = 'stale';
    reason = `no successful run in ${Math.round(ageDays)} days`;
  } else if (!lastSuccessfulRunAt) {
    // Never seen a non-zero run yet — wait until we cross the empty-runs gate.
    status = consecutiveEmptyRuns >= BROKEN_AFTER_EMPTY_RUNS ? 'broken' : 'healthy';
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
    },
    reason,
    status,
  };
}

async function main() {
  const nowIso = new Date().toISOString();
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

main().catch((err) => {
  console.error('[health] Fatal error:', err);
  process.exit(2);
});
