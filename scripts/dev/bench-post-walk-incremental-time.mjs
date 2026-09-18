#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';

const ENTRY_COUNT = Number.parseInt(process.env.POST_WALK_TIME_BENCH_ENTRIES ?? '600000', 10);
const SCAN_PATH_COUNT = Number.parseInt(process.env.POST_WALK_TIME_BENCH_SCAN_PATHS ?? '1500000', 10);
const CHANGED_EVERY = Number.parseInt(process.env.POST_WALK_TIME_BENCH_CHANGED_EVERY ?? '100', 10);
const REMOVED_COUNT = Math.max(1, Math.floor(ENTRY_COUNT / 6000));
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
  selectPostWalkVerificationPaths,
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
  const isPrevious = directory === 'incremental-manifest-prev';
  const manifestEntryCount = ENTRY_COUNT + (isPrevious ? REMOVED_COUNT : 0);
  for (let index = 0; index < manifestEntryCount; index += 1) {
    const hash = changed && index % CHANGED_EVERY === 0
      ? `changed-${index}`
      : `stable-${index}`;
    const removed = isPrevious && index >= ENTRY_COUNT;
    stream.write(`${JSON.stringify({
      path: removed ? `jobs/removed-${index - ENTRY_COUNT}/` : `jobs/entry-${index}/`,
      hash,
      postWalk: {
        jobId: removed ? `removed-job-${index - ENTRY_COUNT}` : `job-${index}`,
        slug: removed ? `removed-${index - ENTRY_COUNT}` : `entry-${index}`,
      },
    })}\n`);
  }
  stream.write(`${JSON.stringify({
    type: 'footer',
    counts: {
      total: manifestEntryCount,
      byKind: {
        'active-job': manifestEntryCount,
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

async function legacyReadManifest(file) {
  const entries = new Map();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let kind = null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === 'kind') {
        kind = record.kind;
      } else if (record.type === undefined) {
        entries.set(record.path, {
          path: record.path,
          inputHash: record.hash,
          kind,
          postWalk: record.postWalk,
        });
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return entries;
}

function legacyLogicalPath(filePath) {
  const relative = filePath.slice(`${DIST_DIR}/`.length);
  return relative.endsWith('/index.html')
    ? relative.slice(0, -'/index.html'.length)
    : relative.slice(0, -'.html'.length);
}

async function runLegacyBaseline(allHtmlPaths) {
  const manifestStartedAt = performance.now();
  const previous = await legacyReadManifest(path.join(ROOT, '.cache/incremental-manifest-prev/it.jsonl'));
  const current = await legacyReadManifest(path.join(ROOT, '.cache/incremental-manifest/it.jsonl'));
  const manifestMs = elapsed(manifestStartedAt);
  const changed = new Set();
  const added = new Set();
  const removed = new Set();
  for (const [logical, entry] of current) {
    const before = previous.get(logical);
    if (!before) added.add(logical);
    else if (before.kind !== entry.kind || before.inputHash !== entry.inputHash) changed.add(logical);
  }
  for (const logical of previous.keys()) {
    if (!current.has(logical)) removed.add(logical);
  }
  if (added.size > 0 || removed.size > 0) {
    await legacyReadManifest(path.join(ROOT, '.cache/incremental-manifest/it.jsonl'));
    await legacyReadManifest(path.join(ROOT, '.cache/incremental-manifest-prev/it.jsonl'));
  }

  const planStartedAt = performance.now();
  const existingHtmlSet = new Set(allHtmlPaths);
  let eligibleByManifest = 0;
  for (const logical of current.keys()) {
    const indexPath = path.join(DIST_DIR, logical, 'index.html');
    const flatPath = path.join(DIST_DIR, `${logical}.html`);
    if (existingHtmlSet.has(indexPath)) eligibleByManifest++;
    if (existingHtmlSet.has(flatPath)) eligibleByManifest++;
  }
  const changedClusters = new Set();
  for (const logical of changed) {
    const entry = current.get(logical);
    if (entry) changedClusters.add(`${entry.kind}\u0000${entry.inputHash}`);
  }
  const selected = new Set();
  for (const filePath of allHtmlPaths) {
    const logical = legacyLogicalPath(filePath);
    const entry = current.get(logical);
    if (!entry || changed.has(logical) || added.has(logical)) selected.add(filePath);
    else if (changedClusters.has(`${entry.kind}\u0000${entry.inputHash}`)) selected.add(filePath);
  }
  const planMs = elapsed(planStartedAt);
  return {
    manifestMs,
    planMs,
    changed: changed.size,
    processed: selected.size,
    eligibleByManifest,
    unmanifested: Math.max(0, allHtmlPaths.length - eligibleByManifest),
  };
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
  const legacy = await runLegacyBaseline(allHtmlPaths);

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
    coveredHtmlPathCount: ENTRY_COUNT,
    state: loaded.state,
  });
  const planMs = elapsed(planStartedAt);
  const verifyStartedAt = performance.now();
  const verificationPaths = selectPostWalkVerificationPaths(
    allHtmlPaths,
    null,
    plan.processHtmlPaths,
    false,
  );
  const verificationSelectionMs = elapsed(verifyStartedAt);
  const report = {
    entries: ENTRY_COUNT,
    scanPaths: SCAN_PATH_COUNT,
    changedEvery: CHANGED_EVERY,
    legacy,
    manifestMs,
    planMs,
    verificationSelectionMs,
    verificationPathCount: verificationPaths.length,
    fullVerificationPathCount: allHtmlPaths.length,
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
