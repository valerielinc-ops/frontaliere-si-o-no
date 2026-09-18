#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ENTRY_COUNT = Number.parseInt(process.env.POST_WALK_TIME_BENCH_ENTRIES ?? '600000', 10);
const SCAN_PATH_COUNT = Number.parseInt(process.env.POST_WALK_TIME_BENCH_SCAN_PATHS ?? '1500000', 10);
const CHANGED_EVERY = Number.parseInt(process.env.POST_WALK_TIME_BENCH_CHANGED_EVERY ?? '100', 10);
const jsonOutput = process.argv.includes('--json');

if (!Number.isInteger(ENTRY_COUNT) || ENTRY_COUNT <= 0) throw new Error('entry count non valido');
if (!Number.isInteger(SCAN_PATH_COUNT) || SCAN_PATH_COUNT < ENTRY_COUNT) {
  throw new Error('scan path count deve contenere tutte le entry del manifest');
}
if (!Number.isInteger(CHANGED_EVERY) || CHANGED_EVERY <= 0) throw new Error('changed interval non valido');

const ROOT = path.join(os.tmpdir(), `post-walk-time-bench-${process.pid}`);
const DIST_DIR = path.join(ROOT, 'dist');
const BASE_URL = 'https://frontaliereticino.ch';
const MODULE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const {
  buildPostWalkIncrementalPlanFromState,
  loadPostWalkManifestState,
} = await import(path.join(MODULE_ROOT, 'build-plugins/shared/postWalkIncremental.ts'));
const { MANIFEST_VERSION } = await import(
  path.join(MODULE_ROOT, 'build-plugins/shared/incrementalManifest.mjs'),
);

function writeManifest(directory, changed) {
  const manifestDir = path.join(ROOT, '.cache', directory);
  fs.mkdirSync(manifestDir, { recursive: true });
  const file = path.join(manifestDir, 'it.jsonl');
  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
  stream.write(`${JSON.stringify({
    type: 'header',
    manifestVersion: MANIFEST_VERSION,
    format: 'jsonl',
    locale: 'it',
  })}\n`);
  stream.write(`${JSON.stringify({
    type: 'kind',
    kind: 'active-job',
    templateVersion: 'active-job@1',
    sourceVersion: 'input@1',
    state: 'live',
  })}\n`);
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const hash = changed && index % CHANGED_EVERY === 0
      ? `changed-${index}`
      : `stable-${index}`;
    stream.write(`${JSON.stringify({
      path: `jobs/entry-${index}/`,
      hash,
      postWalk: { jobId: `job-${index}`, slug: `entry-${index}` },
    })}\n`);
  }
  stream.write(`${JSON.stringify({
    type: 'footer',
    counts: {
      total: ENTRY_COUNT,
      byKind: {
        'active-job': ENTRY_COUNT,
        'expired-soft-landing': 0,
        'legacy-slug-bridge': 0,
        'previous-slugs-full-content': 0,
        'cross-locale-reconciliation': 0,
        'related-search-cluster': 0,
        'related-search-sitemap': 0,
      },
    },
  })}\n`);
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', () => resolve(file));
    stream.end();
  });
}

function makeHtmlPaths() {
  const paths = new Array(SCAN_PATH_COUNT);
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    paths[index] = path.join(DIST_DIR, `jobs/entry-${index}/index.html`);
  }
  for (let index = ENTRY_COUNT; index < SCAN_PATH_COUNT; index += 1) {
    paths[index] = path.join(DIST_DIR, `unmanifested/entry-${index}/index.html`);
  }
  return paths;
}

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(2));
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  await Promise.all([
    writeManifest('incremental-manifest-prev', false),
    writeManifest('incremental-manifest', true),
  ]);
  const allHtmlPaths = makeHtmlPaths();
  const existingHtmlSet = new Set(allHtmlPaths);

  const loadStartedAt = performance.now();
  const loaded = await loadPostWalkManifestState(ROOT, ['it'], BASE_URL);
  const manifestMs = elapsed(loadStartedAt);
  if (!loaded.ok) throw new Error(loaded.reason);

  const planStartedAt = performance.now();
  const plan = buildPostWalkIncrementalPlanFromState({
    distDir: DIST_DIR,
    allHtmlPaths,
    processableHtmlPaths: allHtmlPaths,
    existingHtmlSet,
    baseUrl: BASE_URL,
    readHtml: () => '',
    includeUncoveredPaths: false,
    state: loaded.state,
  });
  const planMs = elapsed(planStartedAt);
  const report = {
    entries: ENTRY_COUNT,
    scanPaths: SCAN_PATH_COUNT,
    changedEvery: CHANGED_EVERY,
    manifestMs,
    planMs,
    mode: plan.mode,
    changed: plan.changed,
    processed: plan.processed,
    skippedUnchanged: plan.skippedUnchanged,
    affected: plan.affected,
    unmanifested: plan.unmanifested,
    unmanifestedSkipped: plan.unmanifestedSkipped,
  };
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (jsonOutput) {
    console.log(JSON.stringify(report));
  } else {
    console.log('[post-walk-incremental-time-bench]');
    console.log(JSON.stringify(report, null, 2));
  }
}

await main();
