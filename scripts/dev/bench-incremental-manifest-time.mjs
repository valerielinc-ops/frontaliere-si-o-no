#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.INCREMENTAL_MANIFEST = '1';

const {
  buildMinimalJobInput,
  getIncrementalManifestInputCache,
  getIncrementalManifestMap,
  getIncrementalManifestMemoryStats,
  resetIncrementalManifestInputCache,
} = await import('../../build-plugins/shared/incrementalManifest.mjs');

const PAGE_COUNT = 100_000;
const BRIDGE_COUNT = Math.round(PAGE_COUNT * 0.3);
const CANONICAL_COUNT = PAGE_COUNT - BRIDGE_COUNT;
const RELATED_COUNT = 30;
const DIGEST_ENTRY_MARGIN = 100;
const MAX_FIXED_MS = 15_000;
const BENCHMARK_LOCALE = 'de';
const jsonOutput = process.argv.includes('--json');
const noAssert = process.argv.includes('--no-assert');

function makeJob(index, prefix = 'job') {
  const id = `${prefix}-${index}`;
  return {
    id,
    slug: `slug-${index}`,
    title: `Job ${index}`,
    titleByLocale: { de: `Job ${index}` },
    slugByLocale: { de: `slug-${index}` },
    sourceRecordHash: `source-${index}`,
    updatedAt: '2026-09-17T00:00:00.000Z',
    crawledAt: '2026-09-17T00:00:00.000Z',
    description: `Description for ${id}`,
    company: `Company ${index % 100}`,
    location: 'Ticino',
    employmentType: 'full-time',
  };
}

function makePageLocalBridgeRecord(canonicalJob, pageIndex, mode) {
  return {
    ...canonicalJob,
    id: mode === 'page-local-bridge-id' ? `bridge-page-${pageIndex}` : canonicalJob.id,
    slug: `previous-${pageIndex}`,
    path: `/${BENCHMARK_LOCALE}/jobs/previous-${pageIndex}`,
    bridgeType: 'previous-slug-bridge',
  };
}

function registerScenarioPage(manifest, mode, pageIndex, pageInput) {
  const kind = pageIndex >= CANONICAL_COUNT
    ? 'previous-slugs-full-content'
    : 'active-job';
  manifest.register(
    `/${BENCHMARK_LOCALE}/jobs/${mode}/${pageIndex}.html`,
    kind,
    pageInput,
  );
}

function runScenario(mode) {
  const rootDir = path.join(os.tmpdir(), `incremental-manifest-time-${mode}`);
  const manifest = getIncrementalManifestMap(rootDir, [BENCHMARK_LOCALE]).get(BENCHMARK_LOCALE);
  const inputCache = getIncrementalManifestInputCache(rootDir, BENCHMARK_LOCALE);
  const relatedJobs = Array.from({ length: RELATED_COUNT }, (_, index) => makeJob(index, 'related'));
  const canonicalJobs = Array.from({ length: CANONICAL_COUNT }, (_, index) => makeJob(index));

  const startedAt = performance.now();
  for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
    const canonicalJob = canonicalJobs[pageIndex % CANONICAL_COUNT];
    const isBridge = pageIndex >= CANONICAL_COUNT;
    const pageJob = isBridge
      ? makePageLocalBridgeRecord(canonicalJob, pageIndex, mode)
      : canonicalJob;
    const pageInput = buildMinimalJobInput(
      pageJob,
      BENCHMARK_LOCALE,
      canonicalJob.slug,
      relatedJobs,
      inputCache,
      mode === 'canonical-reuse' ? canonicalJob : null,
    );

    registerScenarioPage(manifest, mode, pageIndex, isBridge
      ? {
        ...pageInput,
        path: `/${BENCHMARK_LOCALE}/jobs/previous-${pageIndex}.html`,
        sourcePath: `/${BENCHMARK_LOCALE}/jobs/${canonicalJob.slug}.html`,
        bridgeType: 'previous-slug-bridge',
      }
      : pageInput);
  }
  const elapsedMs = performance.now() - startedAt;
  const memoryStats = getIncrementalManifestMemoryStats(rootDir);

  manifest.entriesByPath.clear();
  resetIncrementalManifestInputCache(rootDir);

  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    manifestEntries: memoryStats.records.entries,
    cacheStats: memoryStats.inputCache,
  };
}

function assertReport(report) {
  const fixedDigestEntries = report.fixed.cacheStats.jobDigestsById.entries;
  const fixedDigestComputations = report.fixed.cacheStats.computations.jobDigestComputations;
  const fixedRelatedComputations = report.fixed.cacheStats.computations.relatedProjectionComputations;
  const maxDigestEntries = CANONICAL_COUNT + RELATED_COUNT + DIGEST_ENTRY_MARGIN;

  if (report.fixed.manifestEntries !== PAGE_COUNT) {
    throw new Error(`expected ${PAGE_COUNT} fixed manifest entries, got ${report.fixed.manifestEntries}`);
  }
  if (fixedDigestEntries > maxDigestEntries) {
    throw new Error(`fixed digest entries ${fixedDigestEntries} exceed ${maxDigestEntries}`);
  }
  if (fixedDigestComputations > maxDigestEntries) {
    throw new Error(`fixed digest computations ${fixedDigestComputations} exceed ${maxDigestEntries}`);
  }
  if (fixedRelatedComputations > RELATED_COUNT + 1) {
    throw new Error(`fixed related projections ${fixedRelatedComputations} exceed ${RELATED_COUNT + 1}`);
  }
  if (report.fixed.elapsedMs > MAX_FIXED_MS) {
    throw new Error(`fixed scenario took ${report.fixed.elapsedMs}ms, limit is ${MAX_FIXED_MS}ms`);
  }
}

const report = {
  pages: PAGE_COUNT,
  bridgePages: BRIDGE_COUNT,
  bridgeFraction: BRIDGE_COUNT / PAGE_COUNT,
  canonicalJobs: CANONICAL_COUNT,
  relatedJobs: RELATED_COUNT,
  assertions: {
    maxDigestEntries: CANONICAL_COUNT + RELATED_COUNT + DIGEST_ENTRY_MARGIN,
    maxFixedMs: MAX_FIXED_MS,
  },
  uniqueIdBaseline: runScenario('page-local-bridge-id'),
  sameIdBaseline: runScenario('page-local-bridge-fields'),
  fixed: runScenario('canonical-reuse'),
};

if (!noAssert) assertReport(report);

if (jsonOutput) {
  console.log(JSON.stringify(report));
} else {
  console.log('[incremental-manifest] time benchmark');
  console.log(`pages=${report.pages} bridgePages=${report.bridgePages} bridgeFraction=${report.bridgeFraction}`);
  for (const [name, result] of Object.entries({
    uniqueIdBaseline: report.uniqueIdBaseline,
    sameIdBaseline: report.sameIdBaseline,
    fixed: report.fixed,
  })) {
    console.log(
      `[incremental-manifest] ${name} elapsed_ms=${result.elapsedMs}`,
      `manifest_entries=${result.manifestEntries}`,
      `digest_entries=${result.cacheStats.jobDigestsById.entries}`,
      `digest_computations=${result.cacheStats.computations.jobDigestComputations}`,
      `related_projection_entries=${result.cacheStats.relatedJobProjectionsByKey.entries}`,
      `related_projection_computations=${result.cacheStats.computations.relatedProjectionComputations}`,
    );
  }
}
