#!/usr/bin/env node

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.INCREMENTAL_MANIFEST = '1';

const {
  buildMinimalJobInput,
  computeInputHash,
  computeRelatedJobPoolSignature,
  getIncrementalManifestInputCache,
  getIncrementalManifestMap,
  getIncrementalManifestMemoryStats,
  resetIncrementalManifestInputCache,
} = await import('../../build-plugins/shared/incrementalManifest.mjs');

const PAGE_COUNT = Number.parseInt(process.env.INCREMENTAL_MANIFEST_BENCH_PAGES ?? '10000', 10);
const RELATED_POOL_COUNT = Number.parseInt(process.env.INCREMENTAL_MANIFEST_BENCH_POOL ?? '2162', 10);
const RENDERED_RELATED_COUNT = 6;
const ESTIMATE_RELATED_COUNT = 30;
const TARGET_MS_PER_PAGE = 0.5;
const MAX_FIXED_MS_PER_PAGE = 0.35;
const BENCHMARK_LOCALE = 'it';
const jsonOutput = process.argv.includes('--json');
const noAssert = process.argv.includes('--no-assert');

if (!Number.isInteger(PAGE_COUNT) || PAGE_COUNT <= 0) {
  throw new Error(`INCREMENTAL_MANIFEST_BENCH_PAGES must be a positive integer, got ${PAGE_COUNT}`);
}
if (!Number.isInteger(RELATED_POOL_COUNT) || RELATED_POOL_COUNT < ESTIMATE_RELATED_COUNT) {
  throw new Error(
    `INCREMENTAL_MANIFEST_BENCH_POOL must be an integer >= ${ESTIMATE_RELATED_COUNT}, got ${RELATED_POOL_COUNT}`,
  );
}

const repeat = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

/** Shape copied from a real data/jobs/by-crawler record: four complete locale
 * descriptions, requirements, salary/address fields, and no generated HTML. */
function makeRealJob(index, prefix = 'job') {
  const id = `${prefix}-${index}`;
  const title = `Specialista senior ${id}`;
  const description = repeat(
    `Descrizione del ruolo ${id}: responsabilità, requisiti e informazioni per il candidato. `,
    4430,
  );
  const descriptions = {
    it: description,
    en: repeat(`Job description for ${id}: responsibilities, requirements and candidate information. `, 4430),
    de: repeat(`Stellenbeschreibung für ${id}: Aufgaben, Anforderungen und Informationen für Bewerbende. `, 4430),
    fr: repeat(`Description du poste ${id} : responsabilités, exigences et informations pour la candidature. `, 4430),
  };
  const requirements = [
    `Esperienza nel ruolo ${id}`,
    'Buone capacità organizzative e comunicative',
    'Disponibilità a lavorare in Svizzera',
  ];
  return {
    _targetScope: 'ch',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    applyUrl: `https://example.test/apply/${id}`,
    baseSalary: { value: { minValue: 70_000, maxValue: 95_000, unitText: 'YEAR' } },
    canton: 'TI',
    category: 'engineering',
    company: `Company ${index % 37}`,
    companyDomain: `company-${index % 37}.example.test`,
    companyKey: `company-${index % 37}`,
    contract: 'full-time',
    country: 'CH',
    crawledAt: '2026-09-17T00:00:00.000Z',
    currency: 'CHF',
    description,
    descriptionByLocale: descriptions,
    employmentType: 'FULL_TIME',
    featured: false,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    id,
    location: 'Lugano',
    postedDate: '2026-09-10',
    requirements,
    requirementsByLocale: {
      it: requirements,
      en: requirements.map((item) => `EN ${item}`),
      de: requirements.map((item) => `DE ${item}`),
      fr: requirements.map((item) => `FR ${item}`),
    },
    salaryMax: 95_000,
    salaryMin: 70_000,
    salarySource: 'source',
    slug: `specialista-senior-${id}`,
    slugByLocale: {
      it: `specialista-senior-${id}`,
      en: `senior-specialist-${id}`,
      de: `senior-spezialist-${id}`,
      fr: `specialiste-senior-${id}`,
    },
    source: 'crawler-fixture-shaped-like-production',
    sourceLang: 'it',
    title,
    titleByLocale: {
      it: title,
      en: `Senior specialist ${id}`,
      de: `Senior-Spezialist ${id}`,
      fr: `Spécialiste senior ${id}`,
    },
    url: `https://company-${index % 37}.example.test/jobs/${id}`,
  };
}

function makeBridgeInput(sourceInputHash, pageIndex, suffix = '', jobId = 'primary-0') {
  return {
    source: 'active-job',
    sourceInputHash,
    jobId,
    path: `/${BENCHMARK_LOCALE}/jobs/previous-${pageIndex}${suffix}/`,
    sourcePath: `/${BENCHMARK_LOCALE}/jobs/current-role/`,
    targetPath: `/${BENCHMARK_LOCALE}/jobs/previous-${pageIndex}${suffix}/`,
    bridgeType: 'previous-slug-bridge',
    oldSlug: `previous-${pageIndex}${suffix}`,
    currentSlug: 'current-role',
    action: 'full',
  };
}

function measureRecordDigestCost(records) {
  const iterations = 100;
  let lastDigest = '';
  for (let i = 0; i < 10; i += 1) {
    for (const record of records) {
      lastDigest = createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
    }
  }
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    for (const record of records) {
      lastDigest = createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
    }
  }
  const elapsedMs = performance.now() - startedAt;
  if (!lastDigest) throw new Error('digest benchmark did not produce a digest');
  return Number((elapsedMs / iterations).toFixed(5));
}

function finishScenario(rootDir, manifest, startedAt) {
  const elapsedMs = performance.now() - startedAt;
  const memoryStats = getIncrementalManifestMemoryStats(rootDir);
  const result = {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    msPerPage: Number((elapsedMs / PAGE_COUNT).toFixed(5)),
    projected100kMs: Number((elapsedMs * 100_000 / PAGE_COUNT).toFixed(2)),
    manifestEntries: memoryStats.records.entries,
    cacheStats: memoryStats.inputCache,
  };

  manifest.entriesByPath.clear();
  resetIncrementalManifestInputCache(rootDir);
  return result;
}

function runFullPoolBridgeScenario(label, relatedJobs, sourceJobOrFactory, sourceInputHash) {
  const rootDir = path.join(os.tmpdir(), `incremental-manifest-time-${process.pid}-${label}`);
  const manifest = getIncrementalManifestMap(rootDir, [BENCHMARK_LOCALE]).get(BENCHMARK_LOCALE);
  const inputCache = getIncrementalManifestInputCache(rootDir);
  const startedAt = performance.now();

  for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
    const sourceJob = typeof sourceJobOrFactory === 'function'
      ? sourceJobOrFactory(pageIndex)
      : sourceJobOrFactory;
    const pageInput = {
      ...buildMinimalJobInput(
        sourceJob,
        BENCHMARK_LOCALE,
        sourceJob.slug,
        relatedJobs,
        inputCache,
        sourceJob,
      ),
      ...makeBridgeInput(sourceInputHash, pageIndex, `-${label}`, sourceJob.id || sourceJob.slug),
    };
    manifest.register(
      `/${BENCHMARK_LOCALE}/jobs/${label}/${pageIndex}/`,
      'previous-slugs-full-content',
      pageInput,
    );
  }

  return finishScenario(rootDir, manifest, startedAt);
}

function runCompactBridgeScenario(sourceJob, selectedRelatedJobs, relatedPoolSignature) {
  const label = 'compact-bridge';
  const rootDir = path.join(os.tmpdir(), `incremental-manifest-time-${process.pid}-${label}`);
  const manifest = getIncrementalManifestMap(rootDir, [BENCHMARK_LOCALE]).get(BENCHMARK_LOCALE);
  const inputCache = getIncrementalManifestInputCache(rootDir);
  const activeInput = {
    ...buildMinimalJobInput(
      sourceJob,
      BENCHMARK_LOCALE,
      sourceJob.slug,
      selectedRelatedJobs,
      inputCache,
      sourceJob,
    ),
    canton: 'TI',
    canonicalUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/current-role/',
    relatedPoolSignature,
  };
  const sourceInputHash = computeInputHash(activeInput, 'active-job');
  const startedAt = performance.now();

  for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
    manifest.register(
      `/${BENCHMARK_LOCALE}/jobs/compact-bridge/${pageIndex}/`,
      'previous-slugs-full-content',
      makeBridgeInput(sourceInputHash, pageIndex, '-compact'),
    );
  }

  return finishScenario(rootDir, manifest, startedAt);
}

function assertReport(report) {
  const fixed = report.after;
  if (fixed.manifestEntries !== PAGE_COUNT) {
    throw new Error(`fixed manifest entries ${fixed.manifestEntries} != ${PAGE_COUNT}`);
  }
  if (fixed.msPerPage > MAX_FIXED_MS_PER_PAGE) {
    throw new Error(`fixed scenario took ${fixed.msPerPage}ms/page, limit is ${MAX_FIXED_MS_PER_PAGE}ms/page`);
  }
  if (fixed.projected100kMs > MAX_FIXED_MS_PER_PAGE * 100_000) {
    throw new Error(`fixed projection ${fixed.projected100kMs}ms/100k exceeds the margin budget`);
  }
  if (fixed.cacheStats.computations.jobDigestComputations > 1 + RENDERED_RELATED_COUNT) {
    throw new Error('fixed scenario computed more digests than the source job plus rendered related jobs');
  }
  if (fixed.cacheStats.computations.relatedProjectionComputations > RENDERED_RELATED_COUNT) {
    throw new Error('fixed scenario projected more related records than the rendered selection');
  }
  if (report.before.cacheStats.computations.jobDigestComputations < PAGE_COUNT) {
    throw new Error('page-local baseline did not compute one source digest per distinct bridge record');
  }
  if (report.before.msPerPage <= fixed.msPerPage || report.canonicalBefore.msPerPage <= fixed.msPerPage) {
    throw new Error('full-pool bridge baseline did not cost more per page than the compact bridge');
  }
}

const sourceJob = makeRealJob(0, 'primary');
const relatedPool = Array.from({ length: RELATED_POOL_COUNT }, (_, index) => makeRealJob(index, 'related'));
const relatedThirty = relatedPool.slice(0, ESTIMATE_RELATED_COUNT);
const selectedRelated = relatedPool.slice(0, RENDERED_RELATED_COUNT);
const relatedPoolSignature = computeRelatedJobPoolSignature(relatedPool);
const measuredRecordBytes = Buffer.byteLength(JSON.stringify(sourceJob), 'utf8');
const measuredRelatedBytes = Buffer.byteLength(JSON.stringify(relatedThirty[0]), 'utf8');
const recordPlus30DigestMs = measureRecordDigestCost([sourceJob, ...relatedThirty]);

const report = {
  pages: PAGE_COUNT,
  bridgePages: PAGE_COUNT,
  locale: BENCHMARK_LOCALE,
  relatedPoolCount: RELATED_POOL_COUNT,
  renderedRelatedCount: RENDERED_RELATED_COUNT,
  estimatedRelatedCount: ESTIMATE_RELATED_COUNT,
  realRecordBytes: measuredRecordBytes,
  realRelatedRecordBytes: measuredRelatedBytes,
  recordPlus30DigestMs,
  target: {
    msPerPage: TARGET_MS_PER_PAGE,
    projected100kMs: TARGET_MS_PER_PAGE * 100_000,
    margin: '30% below the 0.5 ms/page production target',
  },
  assertions: {
    maxFixedMsPerPage: MAX_FIXED_MS_PER_PAGE,
    maxFixedProjected100kMs: MAX_FIXED_MS_PER_PAGE * 100_000,
  },
  thirtyRelatedBaseline: runFullPoolBridgeScenario(
    'thirty-related',
    relatedThirty,
    () => sourceJob,
    'a'.repeat(64),
  ),
  before: runFullPoolBridgeScenario(
    'page-local-id-median-related-pool',
    relatedPool,
    (pageIndex) => makeRealJob(pageIndex, 'bridge'),
    'b'.repeat(64),
  ),
  canonicalBefore: runFullPoolBridgeScenario(
    'canonical-id-median-related-pool',
    relatedPool,
    () => sourceJob,
    'c'.repeat(64),
  ),
  after: runCompactBridgeScenario(sourceJob, selectedRelated, relatedPoolSignature),
};

if (!noAssert) assertReport(report);

if (jsonOutput) {
  console.log(JSON.stringify(report));
} else {
  console.log('[incremental-manifest] time benchmark');
  console.log(
    `pages=${report.pages} bridgePages=${report.bridgePages} `
      + `recordBytes=${report.realRecordBytes} relatedPool=${report.relatedPoolCount} `
      + `renderedRelated=${report.renderedRelatedCount} `
      + `recordPlus30DigestMs=${report.recordPlus30DigestMs}`,
  );
  for (const [name, result] of Object.entries({
    thirtyRelatedBaseline: report.thirtyRelatedBaseline,
    before: report.before,
    canonicalBefore: report.canonicalBefore,
    after: report.after,
  })) {
    console.log(
      `[incremental-manifest] ${name} elapsed_ms=${result.elapsedMs}`,
      `ms_per_page=${result.msPerPage}`,
      `projected_100k_ms=${result.projected100kMs}`,
      `manifest_entries=${result.manifestEntries}`,
      `digest_entries=${result.cacheStats.jobDigestsById.entries}`,
      `digest_computations=${result.cacheStats.computations.jobDigestComputations}`,
      `related_projection_entries=${result.cacheStats.relatedJobProjectionsByKey.entries}`,
      `related_projection_computations=${result.cacheStats.computations.relatedProjectionComputations}`,
    );
  }
}
