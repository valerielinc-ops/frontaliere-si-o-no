import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMinimalJobInput,
  computeRelatedJobPoolSignature,
  createIncrementalManifestInputCache,
  IncrementalManifest,
  INCREMENTAL_MANIFEST_ENABLED,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  canonicalizeInput,
  computeInputHash,
  getIncrementalManifestMap,
  getIncrementalManifestMemoryStats,
  releaseIncrementalManifestState,
  verifyRuntimeInputExclusion,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const REPORT = path.join(ROOT, 'scripts/ci/incremental-manifest-report.mjs');
const PREVIOUS = path.join(ROOT, 'tests/fixtures/incremental-manifest/previous.jsonl');
const CURRENT = path.join(ROOT, 'tests/fixtures/incremental-manifest/current.jsonl');

describe('incremental manifest input contract', () => {
  it('canonicalizes object keys independently of insertion order', () => {
    const first = canonicalizeInput({ z: 1, a: { y: true, x: ['one', 2] } });
    const second = canonicalizeInput({ a: { x: ['one', 2], y: true }, z: 1 });
    expect(first).toBe(second);
  });

  it('includes the full job digest and related locale projections', () => {
    const input = buildMinimalJobInput(
      { id: 'job-1', updatedAt: 'v2', title: 'large source object' },
      'de',
      'maurer-v2',
      [
        { id: 'related-1', slugByLocale: { de: 'bezogen-1' }, titleByLocale: { de: 'Related one' } },
        { id: 'related-2', slug: 'related-2', title: 'Related two' },
      ],
    );
    expect(input).toMatchObject({
      jobId: 'job-1',
      jobVersion: 'v2',
      locale: 'de',
      slug: 'maurer-v2',
      relatedJobs: [
        { id: 'related-1', slug: 'bezogen-1', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { id: 'related-2', slug: 'related-2', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
    expect(input.relatedJobs[0]).not.toHaveProperty('title');
    expect(buildMinimalJobInput({ id: 'job-1' }, 'de', 'maurer-v2', ['related-1']).relatedJobs).toEqual([
      { id: 'related-1', slug: '', digest: null },
    ]);
    expect(input.jobRecordDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(computeInputHash(input, 'active-job')).not.toBe(
      computeInputHash(buildMinimalJobInput({ id: 'job-1', updatedAt: 'v3' }, 'de', 'maurer-v2', ['related-1', 'related-2']), 'active-job'),
    );
  });

  it('changes the page hash when only the job title changes', () => {
    const baseJob = { id: 'job-1', updatedAt: 'v2', title: 'Original title' };
    const changedJob = { ...baseJob, title: 'Changed title' };
    const firstHash = computeInputHash(
      buildMinimalJobInput(baseJob, 'it', 'original-title'),
      'active-job',
    );
    const secondHash = computeInputHash(
      buildMinimalJobInput(changedJob, 'it', 'original-title'),
      'active-job',
    );
    expect(secondHash).not.toBe(firstHash);
  });

  it('changes the cross-locale hash when the rendered datePosted changes', () => {
    const cache = createIncrementalManifestInputCache();
    const baseRecord = {
      id: 'cross-locale-job-1',
      slug: 'detailhandelsassistent-in-eba-jumbo-dietlikon-tkbjqj',
      title: 'Detailhandelsassistent',
      sourceRecordHash: 'source-v1',
      datePosted: '2026-08-19T14:02:37.348Z',
      postedDate: '2026-08-19T14:02:37.348Z',
    };
    const changedRecord = {
      ...baseRecord,
      datePosted: '2026-08-19T16:17:13.045Z',
    };
    const crossLocaleInput = (record) => ({
      ...buildMinimalJobInput(record, 'it', record.slug, [], cache, record),
      source: 'active-job',
      sourceInputHash: 'canonical-active-hash',
      path: `/it/jobs/${record.slug}/`,
      baseLocale: 'it',
      foreignSlug: record.slug,
      canton: 'ZH',
      slugPerLocale: { it: record.slug },
      previousSlugsByLocale: {},
    });

    const firstHash = computeInputHash(
      crossLocaleInput(baseRecord),
      'cross-locale-reconciliation',
    );
    const secondHash = computeInputHash(
      crossLocaleInput(changedRecord),
      'cross-locale-reconciliation',
    );

    expect(secondHash).not.toBe(firstHash);
  });

  it('leaves records mutable after taking their identity digest', () => {
    const cache = createIncrementalManifestInputCache();
    const job = {
      id: 'immutable-job-1',
      slug: 'immutable-role',
      title: 'Immutable role',
      datePosted: '2026-08-19T14:02:37.348Z',
      descriptionByLocale: { it: 'Original description' },
      locations: ['Lugano'],
    };

    buildMinimalJobInput(job, 'it', job.slug, [], cache, job);

    // Downstream plugins push into job arrays after the digest is taken:
    // a frozen record broke every production leg (deploy 35397312111).
    expect(Object.isFrozen(job)).toBe(false);
    expect(Object.isFrozen(job.descriptionByLocale)).toBe(false);
    expect(Object.isFrozen(job.locations)).toBe(false);
    expect(() => job.locations.push('Chiasso')).not.toThrow();
    expect(job.locations).toEqual(['Lugano', 'Chiasso']);
  });

  it('recomputes the digest after an in-place mutation of a cached record', () => {
    const cache = createIncrementalManifestInputCache();
    const job = {
      id: 'mutated-job-1',
      slug: 'mutated-role',
      title: 'Mutated role',
      datePosted: '2026-08-19T14:02:37.348Z',
      locations: ['Lugano'],
    };
    const before = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    const cached = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    expect(cached).toBe(before);
    expect(cache._metrics.jobDigestComputations).toBe(1);

    job.locations.push('Chiasso');
    const afterPush = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    expect(afterPush).not.toBe(before);
    expect(cache._metrics.jobDigestComputations).toBe(2);

    job.datePosted = '2026-08-19T16:17:13.045Z';
    const afterReassign = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    expect(afterReassign).not.toBe(afterPush);
    expect(cache._metrics.jobDigestComputations).toBe(3);

    job.locations[0] = 'Mendrisio';
    const afterElementReplace = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    expect(afterElementReplace).not.toBe(afterReassign);
    expect(cache._metrics.jobDigestComputations).toBe(4);

    job.locations = ['Bellinzona', 'Chiasso'];
    const afterSameLengthReassign = buildMinimalJobInput(job, 'it', job.slug, [], cache, job).jobRecordDigest;
    expect(afterSameLengthReassign).not.toBe(afterElementReplace);
    expect(cache._metrics.jobDigestComputations).toBe(5);
  });

  it('changes the page hash when only related company and salary change', () => {
    const pageJob = { id: 'page-1', updatedAt: 'v1', title: 'Page' };
    const relatedJob = {
      id: 'related-1',
      slugByLocale: { it: 'related-job' },
      titleByLocale: { it: 'Related title' },
      company: 'Original company',
      salaryMin: 70_000,
      salaryMax: 90_000,
      currency: 'CHF',
      location: 'Lugano',
      canton: 'TI',
    };
    const changedRelatedJob = {
      ...relatedJob,
      company: 'Changed company',
      salaryMin: 95_000,
    };
    const firstHash = computeInputHash(
      buildMinimalJobInput(pageJob, 'it', 'page', [relatedJob]),
      'related-search-cluster',
    );
    const secondHash = computeInputHash(
      buildMinimalJobInput(pageJob, 'it', 'page', [changedRelatedJob]),
      'related-search-cluster',
    );
    expect(secondHash).not.toBe(firstHash);
  });

  it('keeps the legacy canonical bytes for a minimal job input', () => {
    const input = buildMinimalJobInput(
      { id: 'compat-job', updatedAt: 'fixture-v1', title: 'Role' },
      'it',
      'role',
      [{ id: 'compat-related', slugByLocale: { it: 'related-role' }, company: 'Company' }],
      createIncrementalManifestInputCache(),
    );
    const legacyHash = createHash('sha256')
      .update(`active-job\nactive-job@1\n${JSON.stringify(input)}`, 'utf8')
      .digest('hex');
    expect(computeInputHash(input, 'active-job')).toBe(legacyHash);
  });

  it('reuses content-identical stable-id clones and invalidates changed records', () => {
    const cache = createIncrementalManifestInputCache();
    const primary = {
      id: 'cache-job-1',
      slug: 'cache-job',
      title: 'Role',
      sourceRecordHash: 'cache-v1',
      updatedAt: 'fixture-v1',
    };
    const related = {
      id: 'related-cache-1',
      slugByLocale: { it: 'related-cache-1' },
      sourceRecordHash: 'related-v1',
      title: 'Related role',
    };
    const first = buildMinimalJobInput(
      primary,
      'it',
      'cache-job',
      [related],
      cache,
    );
    const cachedPrimaryDigest = cache.jobDigestsById.get('cache-job-1');
    const second = buildMinimalJobInput(
      { ...primary },
      'it',
      'cache-job',
      [{ ...related }],
      cache,
    );
    expect(second.relatedJobs).toEqual(first.relatedJobs);
    expect(second.relatedJobs[0]).toBe(first.relatedJobs[0]);
    expect(cache.jobDigestsById.get('cache-job-1')).toBe(cachedPrimaryDigest);
    expect(second.jobRecordDigest).toBe(first.jobRecordDigest);
    expect(computeInputHash(second, 'active-job')).toBe(computeInputHash(first, 'active-job'));

    const changed = buildMinimalJobInput(
      { ...primary, title: 'Changed role' },
      'it',
      'cache-job',
      [{ ...related }],
      cache,
    );
    expect(changed.jobRecordDigest).not.toBe(first.jobRecordDigest);
    expect(computeInputHash(changed, 'active-job')).not.toBe(computeInputHash(first, 'active-job'));
    expect(cache.jobDigestsById.get('cache-job-1')).not.toBe(cachedPrimaryDigest);

    const changedRelated = buildMinimalJobInput(
      primary,
      'it',
      'cache-job',
      [{ ...related, sourceRecordHash: 'related-v2', title: 'Changed related role' }],
      cache,
    );
    expect(changedRelated.relatedJobs).not.toBe(first.relatedJobs);
    expect(changedRelated.relatedJobs[0].digest).not.toBe(first.relatedJobs[0].digest);
  });

  it('reuses related projections for expired records keyed only by stable slug', () => {
    const cache = createIncrementalManifestInputCache();
    const expired = {
      slug: 'expired-role',
      title: 'Expired role',
      titleByLocale: { it: 'Expired role' },
      descriptionByLocale: { it: 'Description retained in the expired archive' },
      expiredAt: '2026-09-16T00:00:00.000Z',
      sourceRecordHash: 'expired-v1',
    };
    const first = buildMinimalJobInput(
      { id: 'active-page', title: 'Active page', updatedAt: 'fixture-v1' },
      'it',
      'active-page',
      [expired],
      cache,
    );
    const second = buildMinimalJobInput(
      { id: 'another-active-page', title: 'Another page', updatedAt: 'fixture-v1' },
      'it',
      'another-active-page',
      [{ ...expired, title: 'Expired role' }],
      cache,
    );

    expect(second.relatedJobs[0]).toBe(first.relatedJobs[0]);
    expect(cache.relatedJobProjectionsByKey.size).toBe(1);
    expect(cache._metrics.relatedProjectionComputations).toBe(1);
  });

  it('does not reuse an unversioned clone whose long content changes', () => {
    const cache = createIncrementalManifestInputCache();
    const expired = {
      slug: 'unversioned-expired-role',
      title: 'Expired role',
      descriptionByLocale: { it: `prefix-${'A'.repeat(400)}-suffix` },
    };
    const first = buildMinimalJobInput(
      { id: 'active-page', title: 'Active page', updatedAt: 'fixture-v1' },
      'it',
      'active-page',
      [expired],
      cache,
    );
    const changed = buildMinimalJobInput(
      { id: 'another-active-page', title: 'Another page', updatedAt: 'fixture-v1' },
      'it',
      'another-active-page',
      [{
        ...expired,
        descriptionByLocale: { it: `prefix-${'A'.repeat(199)}B${'A'.repeat(200)}-suffix` },
      }],
      cache,
    );

    expect(changed.relatedJobs[0]).not.toBe(first.relatedJobs[0]);
    expect(changed.relatedJobs[0].digest).not.toBe(first.relatedJobs[0].digest);
    expect(cache._metrics.relatedProjectionComputations).toBe(2);
  });

  it('keeps the complete related pool in a compact page signature', () => {
    const pool = [
      { id: 'related-a', slug: 'a' },
      { id: 'related-b', slug: 'b' },
    ];
    const samePool = pool.map((job) => ({ ...job }));
    expect(computeRelatedJobPoolSignature(samePool)).toBe(computeRelatedJobPoolSignature(pool));
    expect(computeRelatedJobPoolSignature([...pool].reverse())).not.toBe(
      computeRelatedJobPoolSignature(pool),
    );
    expect(computeRelatedJobPoolSignature([{ ...pool[0], slug: 'changed' }, pool[1]])).not.toBe(
      computeRelatedJobPoolSignature(pool),
    );
  });

  it('represents a full-content bridge with its canonical source hash only', () => {
    const cache = createIncrementalManifestInputCache();
    const job = {
      id: 'active-job',
      slug: 'active-role',
      title: 'Active role',
      updatedAt: 'fixture-v1',
      descriptionByLocale: { it: 'A'.repeat(4_000) },
    };
    const activeInput = {
      ...buildMinimalJobInput(job, 'it', job.slug, [], cache),
      relatedPoolSignature: computeRelatedJobPoolSignature([]),
    };
    const sourceInputHash = computeInputHash(activeInput, 'active-job');
    const bridgeInput = {
      source: 'active-job',
      sourceInputHash,
      sourcePath: '/cerca-lavoro-ticino/active-role/',
      targetPath: '/cerca-lavoro-ticino/old-role/',
      bridgeType: 'previous-slug',
      oldSlug: 'old-role',
    };

    expect(bridgeInput).not.toHaveProperty('jobRecordDigest');
    expect(bridgeInput).not.toHaveProperty('relatedJobs');
    expect(JSON.stringify(bridgeInput)).not.toContain('A'.repeat(100));
    expect(computeInputHash(bridgeInput, 'previous-slugs-full-content')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reuses the canonical digest for a bridge record while preserving page-specific input', () => {
    const cache = createIncrementalManifestInputCache();
    const canonicalJob = {
      id: 'canonical-job-1',
      slug: 'canonical-job',
      title: 'Role',
      updatedAt: 'fixture-v1',
    };
    const bridgeRecord = {
      ...canonicalJob,
      id: 'bridge-page-1',
      slug: 'previous-job-slug',
      path: '/de/jobs/previous-job-slug/',
      bridgeType: 'previous-slug-bridge',
    };
    const related = {
      id: 'related-canonical-1',
      slugByLocale: { de: 'related-job' },
      titleByLocale: { de: 'Related role' },
      sourceRecordHash: 'related-canonical-v1',
      updatedAt: 'fixture-v1',
    };
    const activeInput = buildMinimalJobInput(
      canonicalJob,
      'de',
      canonicalJob.slug,
      [related],
      cache,
      canonicalJob,
    );
    const bridgeInput = buildMinimalJobInput(
      bridgeRecord,
      'de',
      canonicalJob.slug,
      [{ ...related }],
      cache,
      canonicalJob,
    );

    expect(bridgeInput.jobId).toBe(canonicalJob.id);
    expect(bridgeInput.jobRecordDigest).toBe(activeInput.jobRecordDigest);
    expect(bridgeInput.jobVersion).toBe(activeInput.jobVersion);
    expect(bridgeInput.relatedJobs[0]).toBe(activeInput.relatedJobs[0]);
    expect(cache.jobDigestsById.size).toBe(2);
    expect(cache.relatedJobProjectionsByKey.size).toBe(1);

    const activePageHash = computeInputHash({
      ...activeInput,
      path: '/de/jobs/canonical-job/',
      bridgeType: 'active-job',
    }, 'previous-slugs-full-content');
    const bridgePageHash = computeInputHash({
      ...bridgeInput,
      path: '/de/jobs/previous-job-slug/',
      bridgeType: 'previous-slug-bridge',
    }, 'previous-slugs-full-content');
    expect(bridgePageHash).not.toBe(activePageHash);
  });

  it('keeps the shadow feature opt-in by default', () => {
    expect(INCREMENTAL_MANIFEST_ENABLED).toBe(false);
  });

  it('shares one per-locale manifest instance between plugin callers', () => {
    const moduleUrl = pathToFileURL(path.join(ROOT, 'build-plugins/shared/incrementalManifest.mjs')).href;
    const script = `
      import { getIncrementalManifestMap } from ${JSON.stringify(moduleUrl)};
      const first = getIncrementalManifestMap('/fixture-root', ['it']);
      const second = getIncrementalManifestMap('/fixture-root', ['it', 'en']);
      console.log(first?.get('it') === second?.get('it') ? 'shared' : 'split');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, INCREMENTAL_MANIFEST: '1' },
    });
    expect(output.trim()).toBe('shared');
  });

  it('releases the build-scoped manifest map at the coordinator boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-release-'));
    try {
      const manifests = getIncrementalManifestMap(root, ['it'], true);
      manifests?.get('it')?.register('jobs/release/', 'active-job', { jobId: 'release-1' });
      expect(getIncrementalManifestMemoryStats(root).records.entries).toBe(1);

      releaseIncrementalManifestState(root);

      const after = getIncrementalManifestMemoryStats(root);
      expect(after.manifests.locales).toBe(0);
      expect(after.records.entries).toBe(0);
      expect(after.estimatedBytes.knownTotal).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not share stale digest entries across builds in one process', () => {
    const moduleUrl = pathToFileURL(path.join(ROOT, 'build-plugins/shared/incrementalManifest.mjs')).href;
    const script = `
      import {
        buildMinimalJobInput,
        getIncrementalManifestInputCache,
        resetIncrementalManifestInputCache,
      } from ${JSON.stringify(moduleUrl)};
      const root = '/fixture-root';
      const firstCache = getIncrementalManifestInputCache(root);
      const first = buildMinimalJobInput(
        { id: 'cache-job-generation', title: 'first title', updatedAt: 'fixture-v1' },
        'it',
        'cache-job-generation',
        [],
        firstCache,
      );
      resetIncrementalManifestInputCache(root);
      const secondCache = getIncrementalManifestInputCache(root);
      const second = buildMinimalJobInput(
        { id: 'cache-job-generation', title: 'second title', updatedAt: 'fixture-v1' },
        'it',
        'cache-job-generation',
        [],
        secondCache,
      );
      console.log(JSON.stringify({
        cacheReplaced: firstCache !== secondCache,
        digestChanged: first.jobRecordDigest !== second.jobRecordDigest,
      }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, INCREMENTAL_MANIFEST: '1' },
    });
    expect(JSON.parse(output.trim())).toEqual({
      cacheReplaced: true,
      digestChanged: true,
    });
  });

  it('excludes build and generation metadata from the hash', () => {
    expect(verifyRuntimeInputExclusion()).toBe(true);
  });

  it('changes the hash when the template version changes', () => {
    const input = { slug: 'muratore', title: 'Muratore' };
    expect(computeInputHash(input, 'active-job', 'active-job@1'))
      .not.toBe(computeInputHash(input, 'active-job', 'active-job@2'));
  });

  it('removes only top-level runtime keys from the job digest', () => {
    const baseJob = {
      id: 'job-1',
      title: 'Role',
      nested: { buildId: 'source-value' },
    };
    const withRuntimeFields = {
      ...baseJob,
      buildId: 'build-a',
      generatedAt: '2026-09-16T12:00:00.000Z',
    };
    const withDifferentNestedValue = {
      ...baseJob,
      nested: { buildId: 'changed-source-value' },
    };
    const hashFor = (job: object) => computeInputHash(
      buildMinimalJobInput(job, 'it', 'role'),
      'active-job',
    );
    expect(hashFor(withRuntimeFields)).toBe(hashFor(baseJob));
    expect(hashFor(withDifferentNestedValue)).not.toBe(hashFor(baseJob));
  });

  it('writes compact, grouped JSONL entries and counters outside dist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-test-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-test-'));
    try {
      const manifest = new IncrementalManifest('it');
      manifest.register('/cerca-lavoro-ticino/zeta/', 'active-job', { slug: 'zeta' });
      manifest.register('/cerca-lavoro-ticino/alfa/', 'expired-soft-landing', { slug: 'alfa' });
      expect(manifest.hasPath('/cerca-lavoro-ticino/zeta/')).toBe(true);
      expect(manifest.getHash('/cerca-lavoro-ticino/zeta/', 'active-job')).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.getHash('/cerca-lavoro-ticino/zeta/', 'expired-soft-landing')).toBeNull();
      const target = manifest.write(tempRoot);
      const secondManifest = new IncrementalManifest('it');
      secondManifest.register('/cerca-lavoro-ticino/alfa/', 'expired-soft-landing', { slug: 'alfa' });
      secondManifest.register('/cerca-lavoro-ticino/zeta/', 'active-job', { slug: 'zeta' });
      const secondTarget = secondManifest.write(secondRoot);
      const lines = fs.readFileSync(target, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(path.relative(tempRoot, target)).toBe('.cache/incremental-manifest/it.jsonl');
      expect(lines[0]).toEqual({
        type: 'header',
        manifestVersion: MANIFEST_VERSION,
        format: MANIFEST_FORMAT,
        locale: 'it',
      });
      expect(lines.filter((line) => line.type === 'kind')).toEqual([
        { type: 'kind', kind: 'active-job', templateVersion: 'active-job@1', sourceVersion: 'input@1', state: 'live' },
        { type: 'kind', kind: 'expired-soft-landing', templateVersion: 'expired-soft-landing@1', sourceVersion: 'input@1', state: 'live' },
      ]);
      const entries = lines.filter((line) => !line.type);
      expect(entries.map((entry: { path: string }) => entry.path)).toEqual([
        'cerca-lavoro-ticino/zeta/',
        'cerca-lavoro-ticino/alfa/',
      ]);
      expect(entries.every((entry) => Object.keys(entry).sort().join(',') === 'hash,path')).toBe(true);
      expect(lines.at(-1)).toMatchObject({
        type: 'footer',
        counts: {
          total: 2,
          byKind: { 'active-job': 1, 'expired-soft-landing': 1 },
        },
      });
      expect(manifest.toJSON().kinds['active-job']).toEqual({
        templateVersion: 'active-job@1',
        sourceVersion: 'input@1',
        state: 'live',
      });
      expect(fs.readFileSync(target, 'utf8')).not.toContain('inputFingerprint');
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(secondTarget, 'utf8'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('writes jobs, related pages, and related sitemap shards into one locale file', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-kinds-'));
    try {
      const manifest = new IncrementalManifest('it');
      manifest.register('/jobs/fixture/', 'active-job', { slug: 'fixture' });
      manifest.register('/ricerca/fixture/', 'related-search-cluster', { slug: 'fixture' });
      manifest.register('sitemap-search-clusters-001.xml', 'related-search-sitemap', {
        locale: 'it',
        shardFile: 'sitemap-search-clusters-001.xml',
        membership: ['https://frontaliereticino.ch/ricerca/fixture/'],
        order: ['https://frontaliereticino.ch/ricerca/fixture/'],
      });

      const target = manifest.write(tempRoot);
      const lines = fs.readFileSync(target, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.type === 'kind').map((line) => line.kind)).toEqual([
        'active-job',
        'related-search-cluster',
        'related-search-sitemap',
      ]);
      expect(lines.at(-1)).toMatchObject({
        type: 'footer',
        counts: {
          total: 3,
          byKind: {
            'active-job': 1,
            'related-search-cluster': 1,
            'related-search-sitemap': 1,
          },
        },
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

});

describe('incremental manifest report', () => {
  it('reads JSONL line-by-line and prints hits, misses, and added/removed paths', () => {
    const output = execFileSync(process.execPath, [REPORT, PREVIOUS, CURRENT], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('| active-job | 1 | 1 | 0 | 0 |');
    expect(output).toContain('| expired-soft-landing | 0 | 1 | 0 | 0 |');
    expect(output).toContain('| legacy-slug-bridge | 0 | 0 | 0 | 1 |');
    expect(output).toContain('| cross-locale-reconciliation | 0 | 0 | 1 | 0 |');
    expect(output).toContain('| related-search-cluster | 1 | 1 | 1 | 1 |');
    expect(output).toContain('| related-search-sitemap | 1 | 0 | 0 | 1 |');
    expect(output).toContain('Collisioni (fingerprint per-entry omesso): non calcolate');
    expect(output).toContain('Path aggiunti (2):');
    expect(output).toContain('cerca-lavoro-ticino/riconciliazione/');
    expect(output).toContain('ricerca/aggiunta/');
    expect(output).toContain('Path rimossi (3):');
    expect(output).toContain('cerca-lavoro-ticino/vecchio-slug/');
    expect(output).toContain('Tombstone candidati (clearStaleClusterSitemaps) (1):');
    expect(output).toContain('sitemap-search-clusters-002.xml');
    expect(output).toContain('Runtime fields esclusi dall’input: OK');
  });
});
