#!/usr/bin/env node
// Build the daily evidence index — aggregates GSC + GA4 data into one JSON
// file consumed by the cascaded scoring + discovery pool layers.
//
// PostHog is no longer read (decisione H9 del 2026-10-05, «rimpiazza PostHog
// con GA4»): it is under quota by choice and its two per-page signals were
// already covered or empty — `pageviews` duplicates GA4 `screenPageViews` /
// `sessions` per pagePath, and `newsletterSignups` counted a
// `newsletter_signup` event the client no longer emits. The output carries no
// `posthog` block; its readers (trafficEvidenceFilter, alert detectors B.4 and
// C.5) already treat it as optional.
//
// Output: data/evidence-index.json
//
// Failure semantics:
//   - 0 fetcher failures → exit 0
//   - 1 fetcher failure  → exit 0 (degraded — log warning)
//   - 2 fetcher failures → exit 1 only when both results are empty
//     (a full data outage); preserved partial observations remain degraded
//
// Optional flag: `--embeddings` triggers `scripts/build-article-embeddings.mjs`
// at the end (delegated to keep this script focused on the JSON ETL).

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { fetchGscQueries } from './lib/evidence/gscFetcher.mjs';
import { fetchGa4Pages } from './lib/evidence/ga4Fetcher.mjs';
import { buildClusterStats } from './lib/evidence/clusterStatsBuilder.mjs';
import { DEFAULT_WINDOW_DAYS } from './lib/evidence/constants.mjs';
import { GA4_READONLY_SCOPE, getServiceAccountToken } from './lib/ga4-service-account.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'data/evidence-index.json');
const EMBEDDINGS_PATH = 'data/article-embeddings.bin';

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function windowDates(days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // 2-day GA4 / GSC reporting lag
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function hasEntries(value) {
  return value != null && typeof value === 'object' && Object.keys(value).length > 0;
}

/**
 * A fetcher can report incomplete coverage after preserving rows it observed.
 * Those rows are still usable evidence; only an empty result is an outage.
 */
export function hasObservedEvidence(result) {
  if (!result || typeof result !== 'object') return false;
  return hasEntries(result.queries)
    || hasEntries(result.pages)
    || (Array.isArray(result.orphanQueries) && result.orphanQueries.length > 0);
}

/**
 * Keep the build fail-closed for a genuine outage while allowing degraded,
 * explicitly-marked partial snapshots to reach the quota tuner.
 */
export function isFullDataOutage(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((result) => !hasObservedEvidence(result));
}

async function runEmbeddingsBuild() {
  return new Promise((resolveProc) => {
    const proc = spawn(
      process.execPath,
      [resolve(__dirname, 'build-article-embeddings.mjs'), '--incremental'],
      { stdio: 'inherit' },
    );
    proc.on('exit', (code) => resolveProc(code ?? 0));
    proc.on('error', () => resolveProc(1));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const buildEmbeddings = args.includes('--embeddings');
  const windowDays = Number(process.env.EVIDENCE_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS;
  const { start: startDate, end: endDate } = windowDates(windowDays);

  console.error(`EVIDENCE_BUILD start=${startDate} end=${endDate} window=${windowDays}d`);

  // Run fetchers in parallel — each is internally resilient (returns error key on failure).
  const [gscResult, ga4Result] = await Promise.all([
    fetchGscQueries({ startDate, endDate }),
    // GA4 is the analytics source (H9); the explicit token call keeps the
    // auth path visible at this consumer, not only inside the fetcher.
    fetchGa4Pages({
      startDate,
      endDate,
      getTokenImpl: () => getServiceAccountToken([GA4_READONLY_SCOPE]),
    }),
  ]);

  const failures = [];
  if (gscResult.error) failures.push(`gsc: ${gscResult.error}`);
  if (ga4Result.error) failures.push(`ga4: ${ga4Result.error}`);
  const fetcherResults = [gscResult, ga4Result];

  for (const f of failures) console.error(`EVIDENCE_FETCHER_FAIL ${f}`);

  // A truncated population must not become the cluster percentile baseline.
  const clusterStats = ga4Result.error ? {} : buildClusterStats(ga4Result.pages || {});

  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    windowDays,
    // Paginated fetchers isolate failures and return
    // partial data alongside `error`, so write whatever they returned rather
    // than dropping every source on any error — dropping would over-thin pages
    // a surviving pass still confirmed. `failures` below still logs/gates the
    // error. Persist that status too: an absent URL in an incomplete source
    // cannot prove zero traffic to the thinning filter.
    gsc: {
      queries: gscResult.queries || {},
      orphanQueries: gscResult.orphanQueries || [],
      pages: gscResult.pages || {},
      ...(gscResult.error ? { error: gscResult.error } : {}),
    },
    ga4: {
      pages: ga4Result.pages || {},
      ...(ga4Result.error ? { error: ga4Result.error } : {}),
      ...(ga4Result.coverage ? { coverage: ga4Result.coverage } : {}),
    },
    clusterStats,
    publishedArticleEmbeddings: EMBEDDINGS_PATH,
  };

  atomicWriteJson(OUTPUT_PATH, index);

  const queryCount = Object.keys(gscResult.queries || {}).length;
  const gscPageCount = Object.keys(gscResult.pages || {}).length;
  const ga4PageCount = Object.keys(ga4Result.pages || {}).length;
  const clusterCount = Object.keys(clusterStats).length;

  console.error(
    `EVIDENCE_BUILD_DONE queries=${queryCount} gscPages=${gscPageCount} ga4Pages=${ga4PageCount} `
    + `clusters=${clusterCount} failures=${failures.length}`,
  );

  if (buildEmbeddings) {
    console.error('EVIDENCE_BUILD_EMBEDDINGS starting incremental build');
    const code = await runEmbeddingsBuild();
    console.error(`EVIDENCE_BUILD_EMBEDDINGS exit=${code}`);
  }

  if (failures.length === fetcherResults.length && isFullDataOutage(fetcherResults)) {
    console.error(`EVIDENCE_BUILD_FATAL all ${fetcherResults.length} fetchers failed — exiting 1`);
    process.exit(1);
  }
  if (failures.length === fetcherResults.length) {
    const observed = fetcherResults.filter(hasObservedEvidence).length;
    console.error(
      `EVIDENCE_BUILD_DEGRADED all ${fetcherResults.length} fetchers reported incomplete results; `
      + `observed evidence retained from ${observed} source(s) — continuing`,
    );
  }
  process.exit(0);
}

function isMain() {
  try {
    const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
    return import.meta.url === entry;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error('EVIDENCE_BUILD_UNCAUGHT', err);
    process.exit(1);
  });
}
