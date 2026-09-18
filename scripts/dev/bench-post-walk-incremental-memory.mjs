#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_COUNT = Number.parseInt(process.env.POST_WALK_BENCH_ENTRIES ?? '700000', 10);
const SCAN_PATH_COUNT = Number.parseInt(process.env.POST_WALK_BENCH_SCAN_PATHS ?? '1500000', 10);
const ALIAS_FRACTION = 0.3;
const TARGET_RETAINED_HEAP_MB = Number.parseInt(
  process.env.POST_WALK_BENCH_TARGET_MB ?? '500',
  10,
);
const MAX_RETAINED_HEAP_MB = Math.ceil(TARGET_RETAINED_HEAP_MB * 1.2);
const jsonOutput = process.argv.includes('--json');
const assertBudget = !process.argv.includes('--no-assert');

if (typeof global.gc !== 'function') {
  throw new Error('Questo benchmark richiede node --expose-gc');
}
if (!Number.isInteger(ENTRY_COUNT) || ENTRY_COUNT <= 0) throw new Error('entry count non valido');
if (!Number.isInteger(SCAN_PATH_COUNT) || SCAN_PATH_COUNT < ENTRY_COUNT * 2) {
  throw new Error('scan path count deve contenere due alias fisici per entry');
}

const DIST_DIR = '/synthetic/frontaliere/dist';
const CANONICAL_COUNT = Math.round(ENTRY_COUNT * (1 - ALIAS_FRACTION));
const ALIAS_COUNT = ENTRY_COUNT - CANONICAL_COUNT;
const UNTRACKED_COUNT = SCAN_PATH_COUNT - ENTRY_COUNT * 2;
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  buildPostWalkIncrementalPlanFromState,
  selectPostWalkVerificationPaths,
} = await import(path.join(MODULE_ROOT, 'build-plugins/shared/postWalkIncremental.ts'));

function forceGc() {
  for (let pass = 0; pass < 3; pass += 1) {
    global.gc({ type: 'major', execution: 'sync' });
  }
}

function heapAfterGc() {
  forceGc();
  return process.memoryUsage().heapUsed;
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function logicalPath(index) {
  if (index < CANONICAL_COUNT) return `jobs/senior-specialist-${index}-zuerich`;
  return `jobs/legacy-senior-specialist-${index - CANONICAL_COUNT}-zuerich`;
}

function jobIdFor(index) {
  return index < CANONICAL_COUNT
    ? `job-${index}`
    : `job-${index - CANONICAL_COUNT}`;
}

function slugFor(index) {
  return index < CANONICAL_COUNT
    ? `senior-specialist-${index}-zuerich`
    : `legacy-senior-specialist-${index - CANONICAL_COUNT}-zuerich`;
}

function scanPathFor(logical, alias) {
  return alias
    ? `${DIST_DIR}/${logical}.html`
    : `${DIST_DIR}/${logical}/index.html`;
}

function makeScanPaths() {
  const paths = new Array(SCAN_PATH_COUNT);
  let cursor = 0;
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const logical = logicalPath(index);
    paths[cursor] = scanPathFor(logical, false);
    cursor += 1;
    paths[cursor] = scanPathFor(logical, true);
    cursor += 1;
  }
  for (let index = 0; index < UNTRACKED_COUNT; index += 1) {
    paths[cursor] = `${DIST_DIR}/landing/untracked-${index}/index.html`;
    cursor += 1;
  }
  return paths;
}

function compactEntry(index, changed) {
  const logical = logicalPath(index);
  const jobId = jobIdFor(index);
  const entry = {
    path: logical,
    inputHash: changed ? `hash-current-${index}` : `hash-stable-${jobId}`,
    kind: index < CANONICAL_COUNT ? 'active-job' : 'legacy-slug-bridge',
    postWalk: {
      jobId,
      slug: slugFor(index),
    },
  };
  return entry;
}

function fullEntry(index, changed, previous) {
  const logical = logicalPath(index);
  const jobId = jobIdFor(index);
  const slug = slugFor(index);
  const canonicalPath = `jobs/${slug}`;
  const entry = {
    path: logical,
    inputHash: changed && !previous ? `hash-current-${index}` : `hash-stable-${jobId}`,
    kind: index < CANONICAL_COUNT ? 'active-job' : 'legacy-slug-bridge',
    input: {
      jobId,
      slug,
      title: `Senior Specialist ${index}`,
      description: `Detailed description for job ${index}. `.repeat(3),
      locale: 'it',
      aliases: index >= CANONICAL_COUNT ? [canonicalPath, logical] : [canonicalPath],
      relatedJobs: RELATED_JOB_FIXTURES,
    },
    postWalk: {
      jobIds: [jobId],
      slugs: [slug],
    },
  };
  if (index >= CANONICAL_COUNT) {
    entry.postWalk.references = [
      `${DIST_DIR}/${canonicalPath}.html`,
      `${DIST_DIR}/${canonicalPath}/index.html`,
    ];
  }
  return entry;
}

const RELATED_JOB_FIXTURES = Array.from({ length: 8 }, (_, index) => ({
  id: `related-${index}`,
  slug: `related-specialist-${index}`,
  title: `Related Specialist ${index}`,
  location: index % 2 === 0 ? 'Zürich' : 'Lugano',
  company: `Employer ${index}`,
  description: `Related role ${index}: requirements, tasks and working conditions.`,
}));

function measurePhase(phases, baseHeap, name, callback) {
  callback();
  const heap = heapAfterGc();
  phases.push({
    name,
    heapMB: mb(heap),
    retainedMB: mb(Math.max(0, heap - baseHeap)),
  });
}

function phaseReport(phases) {
  return {
    phases,
    peakRetainedMB: Math.max(...phases.map((phase) => phase.retainedMB), 0),
  };
}

function runLegacy(scanPaths) {
  const baseHeap = heapAfterGc();
  const phases = [];
  const state = {
    allHtmlPaths: scanPaths,
    processableHtmlPaths: scanPaths,
    existingHtmlSet: new Set(scanPaths),
    current: new Map(),
    previous: new Map(),
    byLogical: new Map(),
    byAbsolute: new Map(),
    currentHtmlEntries: new Map(),
    previousHtmlEntries: new Map(),
    processable: new Set(scanPaths),
    entryByHtmlPath: new Map(),
    reasonsByPath: new Map(),
    selected: new Set(),
  };

  measurePhase(phases, baseHeap, 'legacy:scan+existing-set', () => {});
  measurePhase(phases, baseHeap, 'legacy:materialized-manifest-pair', () => {
    for (let index = 0; index < ENTRY_COUNT; index += 1) {
      state.current.set(logicalPath(index), fullEntry(index, index % 100 === 0, false));
      state.previous.set(logicalPath(index), fullEntry(index, false, true));
    }
  });
  measurePhase(phases, baseHeap, 'legacy:html-logical-indexes', () => {
    for (const filePath of scanPaths) {
      const relative = filePath.slice(`${DIST_DIR}/`.length);
      const logical = relative.endsWith('/index.html')
        ? relative.slice(0, -'/index.html'.length)
        : relative.slice(0, -'.html'.length);
      state.byAbsolute.set(filePath, logical);
      const physical = state.byLogical.get(logical) ?? [];
      physical.push(filePath);
      state.byLogical.set(logical, physical);
    }
  });
  measurePhase(phases, baseHeap, 'legacy:duplicate-plan-indexes', () => {
    for (const [logical, entry] of state.current) {
      state.currentHtmlEntries.set(logical, entry);
    }
    for (const [logical, entry] of state.previous) {
      state.previousHtmlEntries.set(logical, entry);
    }
    for (const filePath of scanPaths) {
      const logical = state.byAbsolute.get(filePath);
      if (state.currentHtmlEntries.has(logical)) state.entryByHtmlPath.set(filePath, state.currentHtmlEntries.get(logical));
      if (!state.currentHtmlEntries.has(logical)) state.reasonsByPath.set(filePath, new Set());
      else if (logical.endsWith('-0-zuerich') || logical.endsWith('-100-zuerich')) {
        state.reasonsByPath.set(filePath, new Set(['changed']));
      }
      if (state.reasonsByPath.has(filePath)) state.selected.add(filePath);
    }
  });
  measurePhase(phases, baseHeap, 'legacy:worker-existing-set-clones', () => {
    // POST_WALK_WORKERS=2 was the canary configuration. Each worker used to
    // receive the full path array and rebuild this Set after structured clone.
    state.workerExistingSets = [new Set(scanPaths), new Set(scanPaths)];
  });
  const report = phaseReport(phases);
  return report;
}

function runStreaming(scanPaths) {
  const baseHeap = heapAfterGc();
  const phases = [];
  const state = {
    allHtmlPaths: scanPaths,
    processableHtmlPaths: scanPaths,
    existingHtmlSet: new Set(scanPaths),
    currentEntries: new Map(),
    changed: new Set(),
    added: new Set(),
    removed: new Set(['jobs/removed-page-no-identity']),
    affected: new Set(),
  };

  measurePhase(phases, baseHeap, 'streaming:scan+existing-set', () => {});
  measurePhase(phases, baseHeap, 'streaming:current-minimal-projection', () => {
    for (let index = 0; index < ENTRY_COUNT; index += 1) {
      const changed = index < CANONICAL_COUNT && index % 100 === 0;
      const entry = compactEntry(index, changed);
      state.currentEntries.set(entry.path, entry);
      if (changed) {
        state.changed.add(entry.path);
        const aliasIndex = CANONICAL_COUNT + index;
        if (aliasIndex < ENTRY_COUNT) state.affected.add(logicalPath(aliasIndex));
      }
    }
  });
  const current = {
    locales: ['it'],
    entries: state.currentEntries,
    kinds: new Map([
      ['active-job', JSON.stringify({ templateVersion: 'bench', sourceVersion: 'bench', state: 'live' })],
      ['legacy-slug-bridge', JSON.stringify({ templateVersion: 'bench', sourceVersion: 'bench', state: 'live' })],
    ]),
  };
  const manifestState = {
    current,
    currentEntryCount: ENTRY_COUNT,
    previousEntryCount: ENTRY_COUNT,
    previousKinds: current.kinds,
    changed: state.changed,
    added: state.added,
    removed: state.removed,
    affected: state.affected,
    unresolvedRemovals: new Set(),
  };
  measurePhase(phases, baseHeap, 'streaming:bounded-plan', () => {
    state.plan = buildPostWalkIncrementalPlanFromState({
      distDir: DIST_DIR,
      allHtmlPaths: scanPaths,
      processableHtmlPaths: scanPaths,
      baseUrl: 'https://frontaliereticino.ch',
      existingHtmlSet: state.existingHtmlSet,
      readHtml: () => '',
      state: manifestState,
    });
  });
  measurePhase(phases, baseHeap, 'streaming:verify-bounded-sample', () => {
    // The verifier keeps only the deterministic sample plus the already
    // selected affected paths; it never materialises a second full walk.
    state.verificationPaths = selectPostWalkVerificationPaths(
      scanPaths,
      Math.ceil(SCAN_PATH_COUNT * 0.02),
      state.plan.processHtmlPaths,
      false,
    );
  });
  const report = phaseReport(phases);
  report.plan = {
    mode: state.plan.mode,
    processed: state.plan.processed,
    eligibleByManifest: state.plan.eligibleByManifest,
  };
  report.verificationPathCount = state.verificationPaths.length + state.plan.processed;
  return report;
}

const legacy = runLegacy(makeScanPaths());
forceGc();
const streaming = runStreaming(makeScanPaths());
const report = {
  entryCount: ENTRY_COUNT,
  scanPathCount: SCAN_PATH_COUNT,
  aliasFraction: ALIAS_FRACTION,
  aliasCount: ALIAS_COUNT,
  untrackedPathCount: UNTRACKED_COUNT,
  legacy,
  streaming,
  budget: {
    targetRetainedHeapMB: TARGET_RETAINED_HEAP_MB,
    maxRetainedHeapMB: MAX_RETAINED_HEAP_MB,
    margin: '20%',
    passed: streaming.peakRetainedMB <= MAX_RETAINED_HEAP_MB,
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report));
} else {
  console.log('[post-walk-incremental-memory-bench]');
  console.log(
    `entries=${ENTRY_COUNT} scan_paths=${SCAN_PATH_COUNT} aliases=${ALIAS_COUNT} `
      + `alias_fraction=${ALIAS_FRACTION}`,
  );
  for (const [name, scenario] of Object.entries({ legacy, streaming })) {
    console.log(`${name}_peak_retained_heap=${scenario.peakRetainedMB}MB`);
    for (const phase of scenario.phases) {
      console.log(`${name}_${phase.name} heap=${phase.heapMB}MB retained=${phase.retainedMB}MB`);
    }
  }
  console.log(
    `budget=${MAX_RETAINED_HEAP_MB}MB (target=${TARGET_RETAINED_HEAP_MB}MB margin=20%) `
      + `passed=${report.budget.passed}`,
  );
}

if (assertBudget && !report.budget.passed) {
  throw new Error(
    `streaming retained heap ${streaming.peakRetainedMB} MB supera il budget ${MAX_RETAINED_HEAP_MB} MB`,
  );
}
