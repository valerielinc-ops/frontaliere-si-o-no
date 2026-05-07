#!/usr/bin/env node
// Build the daily evidence index — aggregates GSC + GA4 + PostHog data into
// one JSON file consumed by the cascaded scoring + discovery pool layers.
//
// Output: data/evidence-index.json
//
// Failure semantics:
//   - 0 fetcher failures → exit 0
//   - 1 fetcher failure  → exit 0 (degraded — log warning)
//   - 2 fetcher failures → exit 0 (still degraded but not catastrophic)
//   - 3 fetcher failures → exit 1 (full data outage)
//
// Optional flag: `--embeddings` triggers `scripts/build-article-embeddings.mjs`
// at the end (delegated to keep this script focused on the JSON ETL).

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { fetchGscQueries } from './lib/evidence/gscFetcher.mjs';
import { fetchGa4Pages } from './lib/evidence/ga4Fetcher.mjs';
import { fetchPosthogPages } from './lib/evidence/posthogFetcher.mjs';
import { buildClusterStats } from './lib/evidence/clusterStatsBuilder.mjs';
import { DEFAULT_WINDOW_DAYS } from './lib/evidence/constants.mjs';

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
  const [gscResult, ga4Result, posthogResult] = await Promise.all([
    fetchGscQueries({ startDate, endDate }),
    fetchGa4Pages({ startDate, endDate }),
    fetchPosthogPages({ startDate, endDate }),
  ]);

  const failures = [];
  if (gscResult.error) failures.push(`gsc: ${gscResult.error}`);
  if (ga4Result.error) failures.push(`ga4: ${ga4Result.error}`);
  if (posthogResult.error) failures.push(`posthog: ${posthogResult.error}`);

  for (const f of failures) console.error(`EVIDENCE_FETCHER_FAIL ${f}`);

  // Compute cluster stats from GA4 pages (may be empty if GA4 failed).
  const clusterStats = buildClusterStats(ga4Result.pages || {});

  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    windowDays,
    gsc: gscResult.error
      ? {}
      : { queries: gscResult.queries, orphanQueries: gscResult.orphanQueries },
    ga4: ga4Result.error ? {} : { pages: ga4Result.pages },
    posthog: posthogResult.error ? {} : { pages: posthogResult.pages },
    clusterStats,
    publishedArticleEmbeddings: EMBEDDINGS_PATH,
  };

  atomicWriteJson(OUTPUT_PATH, index);

  const queryCount = Object.keys(gscResult.queries || {}).length;
  const ga4PageCount = Object.keys(ga4Result.pages || {}).length;
  const posthogPageCount = Object.keys(posthogResult.pages || {}).length;
  const clusterCount = Object.keys(clusterStats).length;

  console.error(
    `EVIDENCE_BUILD_DONE queries=${queryCount} ga4Pages=${ga4PageCount} `
    + `posthogPages=${posthogPageCount} clusters=${clusterCount} failures=${failures.length}`,
  );

  if (buildEmbeddings) {
    console.error('EVIDENCE_BUILD_EMBEDDINGS starting incremental build');
    const code = await runEmbeddingsBuild();
    console.error(`EVIDENCE_BUILD_EMBEDDINGS exit=${code}`);
  }

  if (failures.length >= 3) {
    console.error('EVIDENCE_BUILD_FATAL all 3 fetchers failed — exiting 1');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('EVIDENCE_BUILD_UNCAUGHT', err);
  process.exit(1);
});
