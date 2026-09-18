#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

import { intFromEnv, positiveIntFromEnv } from '../lib/int-from-env.mjs';

const RECORD_COUNT = positiveIntFromEnv('MANIFEST_BENCH_RECORDS', 100_000);
const RELATED_PER_RECORD = positiveIntFromEnv('MANIFEST_BENCH_RELATED', 30);
const DE_RECORD_COUNT = 811_433;
const RETAINED_HEAP_BUDGET_MB = intFromEnv('MANIFEST_BENCH_MAX_RETAINED_MB', 120);
const jsonOutput = process.argv.includes('--json');
const assertBudget = !process.argv.includes('--no-assert');
const legacyListCache = process.env.MANIFEST_BENCH_LEGACY_LIST_CACHE === '1';

if (typeof global.gc !== 'function') {
  throw new Error('Questo benchmark richiede node --expose-gc');
}

// The benchmark is deliberately self-contained: it enables the same flag used
// by the build before loading the module, so its true APIs are exercised even
// when the caller forgets to export INCREMENTAL_MANIFEST=1.
process.env.INCREMENTAL_MANIFEST = '1';
const {
  buildMinimalJobInput,
  getIncrementalManifestInputCache,
  getIncrementalManifestMap,
  getIncrementalManifestMemoryStats,
  stableJobId,
} = await import('../../build-plugins/shared/incrementalManifest.mjs');

const rootDir = path.join(os.tmpdir(), `incremental-manifest-memory-${process.pid}`);
const manifests = getIncrementalManifestMap(rootDir, ['de'], true);
const manifest = manifests?.get('de');
const inputCache = getIncrementalManifestInputCache(rootDir);
if (!manifest || !inputCache) throw new Error('Le API del manifest non hanno restituito lo stato atteso');

function forceGc() {
  for (let pass = 0; pass < 3; pass += 1) global.gc({ type: 'major', execution: 'sync' });
}

function heapUsedAfterGc() {
  let lowest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample += 1) {
    forceGc();
    lowest = Math.min(lowest, process.memoryUsage().heapUsed);
  }
  return lowest;
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function makeRelatedJob(index) {
  const slug = `related-fachkraft-${index}`;
  const title = `Related Fachkraft ${index}`;
  const description = `Beschreibung der verwandten Stelle ${index}: Aufgaben, Anforderungen und Arbeitsbedingungen. `.repeat(24);
  return {
    id: `related-${index}`,
    slug,
    slugByLocale: { it: slug, en: slug, de: slug, fr: slug },
    title,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    sourceRecordHash: `related-source-${index}`,
    updatedAt: 'fixture-v1',
    description,
    descriptionByLocale: { it: description, en: description, de: description, fr: description },
    company: `Arbeitgeber ${index % 7}`,
    companyKey: `arbeitgeber-${index % 7}`,
    location: index % 2 === 0 ? 'Zürich' : 'Basel',
    canton: index % 2 === 0 ? 'ZH' : 'BS',
    employmentType: 'FULL_TIME',
    salaryMin: 70_000,
    salaryMax: 95_000,
    currency: 'CHF',
  };
}

function makePageJob(index) {
  const slug = `senior-spezialist-${index}-zuerich`;
  const title = `Senior Spezialist ${index}`;
  const description = `Ausführliche Beschreibung der Stelle ${index}: Verantwortlichkeiten, Anforderungen und Hinweise für Bewerbende. `.repeat(24);
  return {
    id: `job-${index}`,
    slug,
    slugByLocale: { it: slug, en: slug, de: slug, fr: slug },
    title,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    sourceRecordHash: `source-${index}`,
    updatedAt: 'fixture-v1',
    description,
    descriptionByLocale: { it: description, en: description, de: description, fr: description },
    company: `Employer ${index % 37}`,
    companyKey: `employer-${index % 37}`,
    location: index % 2 === 0 ? 'Zürich' : 'Basel',
    canton: index % 2 === 0 ? 'ZH' : 'BS',
    employmentType: 'FULL_TIME',
    salaryMin: 70_000,
    salaryMax: 95_000,
    currency: 'CHF',
  };
}

// Keep the same 30 object references for every page. This is the production
// shape that makes the per-job projection cache useful; only the page record
// and its canonical/legacy path vary per registration.
const sharedRelatedJobs = Array.from({ length: RELATED_PER_RECORD }, (_, index) => makeRelatedJob(index));
if (legacyListCache) inputCache.relatedProjectionListsByKey = new Map();
const beforeHeap = heapUsedAfterGc();
let activeCount = 0;
let legacyCount = 0;

for (let index = 0; index < RECORD_COUNT; index += 1) {
  const job = makePageJob(index);
  const stableId = stableJobId(job);
  if (stableId !== job.id) throw new Error(`stableJobId inatteso per ${job.id}`);

  const canonicalPath = `de/jobs-im-zuerich/${job.slug}/`;
  const legacyPath = `de/jobs-im-tessin/${job.slug}/`;
  const isLegacyAlias = index % 5 === 0;
  const input = buildMinimalJobInput(job, 'de', job.slug, sharedRelatedJobs, inputCache);
  if (legacyListCache) {
    const relatedIds = sharedRelatedJobs.map((relatedJob) => stableJobId(relatedJob));
    inputCache.relatedProjectionListsByKey.set(
      `${stableId}\u0000de\u0000${relatedIds.join('\u0000')}`,
      {
        digests: sharedRelatedJobs.map((relatedJob) => (
          inputCache.jobDigestsById.get(stableJobId(relatedJob))?.digest ?? null
        )),
        projections: input.relatedJobs,
      },
    );
  }
  if (isLegacyAlias) legacyCount += 1;
  else activeCount += 1;
  manifest.register(
    isLegacyAlias ? legacyPath : canonicalPath,
    isLegacyAlias ? 'legacy-slug-bridge' : 'active-job',
    isLegacyAlias
      ? {
          ...input,
          bridgeType: 'locale-slug',
          sourcePath: canonicalPath,
          targetPath: legacyPath,
          legacySlug: job.slug,
          canton: job.canton,
        }
      : {
          ...input,
          canonicalUrl: `https://frontaliereticino.ch/${canonicalPath}`,
          canton: job.canton,
        },
  );
}

manifest.setJobsSeoEmitterFingerprint({
  'active-job': 'benchmark-active',
  'legacy-slug-bridge': 'benchmark-legacy',
});

const fullHeap = heapUsedAfterGc();
const fullStats = getIncrementalManifestMemoryStats(rootDir);

// Release one retained structure at a time. The differences are retained-set
// measurements, not V8 object-size claims; shared objects can be counted by
// more than one logical cache, so the report keeps the categories explicit.
inputCache.relatedProjectionListsByKey?.clear();
const withoutRelatedProjectionListsHeap = heapUsedAfterGc();
manifest.entriesByPath.clear();
const withoutRecordsHeap = heapUsedAfterGc();
inputCache.relatedJobProjectionsByKey.clear();
const withoutRelatedProjectionsHeap = heapUsedAfterGc();
inputCache.jobDigestsById.clear();
const withoutStrongCachesHeap = heapUsedAfterGc();

const retainedHeapMB = mb(fullHeap - beforeHeap);
const retainedDelta = (after, before) => Math.max(0, mb(after - before));
const retainedByStructureMB = {
  relatedProjectionListsByKey: retainedDelta(fullHeap, withoutRelatedProjectionListsHeap),
  entriesByPath: retainedDelta(withoutRelatedProjectionListsHeap, withoutRecordsHeap),
  relatedJobProjectionsByKey: retainedDelta(withoutRecordsHeap, withoutRelatedProjectionsHeap),
  jobDigestsById: retainedDelta(withoutRelatedProjectionsHeap, withoutStrongCachesHeap),
};
const inputCacheRetainedMB = retainedDelta(withoutRecordsHeap, beforeHeap);
const extrapolate = (value) => Number((value * DE_RECORD_COUNT / RECORD_COUNT).toFixed(2));
const report = {
  mode: legacyListCache ? 'legacy-list-cache-reference' : 'per-id-projection-cache',
  recordCount: RECORD_COUNT,
  relatedPerRecord: RELATED_PER_RECORD,
  locale: 'de',
  manifestCounts: {
    total: RECORD_COUNT,
    byKind: {
      'active-job': activeCount,
      'legacy-slug-bridge': legacyCount,
    },
  },
  heapMB: {
    beforeGc: mb(beforeHeap),
    fullAfterGc: mb(fullHeap),
    retained: retainedHeapMB,
    inputCacheAfterRecordsRelease: inputCacheRetainedMB,
    afterReleasingStrongCaches: retainedDelta(withoutStrongCachesHeap, beforeHeap),
  },
  retainedByStructureMB,
  cacheStats: fullStats,
  weakMapObservation: {
    caches: Object.keys(fullStats.weakMaps),
    entries: null,
    sharedRelatedJobObjects: sharedRelatedJobs.length,
  },
  extrapolationToDE811433Records: {
    factor: Number((DE_RECORD_COUNT / RECORD_COUNT).toFixed(4)),
    retainedHeapMB: extrapolate(retainedHeapMB),
    inputCacheMB: extrapolate(inputCacheRetainedMB),
    relatedProjectionListsMB: extrapolate(retainedByStructureMB.relatedProjectionListsByKey),
    recordsMB: extrapolate(retainedByStructureMB.entriesByPath),
    jobDigestsMB: extrapolate(retainedByStructureMB.jobDigestsById),
  },
  budget: {
    maxRetainedHeapMB: RETAINED_HEAP_BUDGET_MB,
    margin: '20% over the 100 MB target',
    passed: retainedHeapMB <= RETAINED_HEAP_BUDGET_MB,
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report));
} else {
  console.log(`[incremental-manifest-bench] records=${RECORD_COUNT} related_per_record=${RELATED_PER_RECORD}`);
  console.log(`[incremental-manifest-bench] retained_heap_after_gc=${retainedHeapMB}MB budget=${RETAINED_HEAP_BUDGET_MB}MB`);
  for (const [name, value] of Object.entries(retainedByStructureMB)) {
    console.log(`[incremental-manifest-bench] retained_${name}=${value}MB`);
  }
  console.log(
    `[incremental-manifest-bench] DE_811433 retained=${report.extrapolationToDE811433Records.retainedHeapMB}MB `
    + `input_cache=${report.extrapolationToDE811433Records.inputCacheMB}MB `
    + `related_lists=${report.extrapolationToDE811433Records.relatedProjectionListsMB}MB`,
  );
  console.log(`[incremental-manifest-bench] cache_stats=${JSON.stringify(fullStats)}`);
}

if (assertBudget && !report.budget.passed) {
  throw new Error(
    `retained heap ${retainedHeapMB} MB supera il budget ${RETAINED_HEAP_BUDGET_MB} MB per ${RECORD_COUNT} record`,
  );
}
