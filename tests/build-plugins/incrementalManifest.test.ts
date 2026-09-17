import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMinimalJobInput,
  createIncrementalManifestInputCache,
  IncrementalManifest,
  INCREMENTAL_MANIFEST_ENABLED,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  canonicalizeInput,
  computeInputHash,
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

  it('reuses digest and related projections across stable-id clones within one build cache', () => {
    const cache = createIncrementalManifestInputCache();
    const related = {
      id: 'related-cache-1',
      slugByLocale: { it: 'related-cache-1' },
      title: 'Related role',
    };
    const first = buildMinimalJobInput(
      { id: 'cache-job-1', slug: 'cache-job', title: 'Role', updatedAt: 'fixture-v1' },
      'it',
      'cache-job',
      [related],
      cache,
    );
    const second = buildMinimalJobInput(
      { id: 'cache-job-1', slug: 'cache-job', title: 'Role', updatedAt: 'fixture-v1' },
      'it',
      'cache-job',
      [{ ...related, title: 'Recreated related projection' }],
      cache,
    );
    expect(second.relatedJobs).toBe(first.relatedJobs);
    expect(second.relatedJobs[0]).toBe(first.relatedJobs[0]);
    expect(computeInputHash(second, 'active-job')).toBe(computeInputHash(first, 'active-job'));

    const changedBuildCache = createIncrementalManifestInputCache();
    const changed = buildMinimalJobInput(
      { id: 'cache-job-1', slug: 'cache-job', title: 'Changed role', updatedAt: 'fixture-v1' },
      'it',
      'cache-job',
      [{ ...related, title: 'Related role' }],
      changedBuildCache,
    );
    expect(computeInputHash(changed, 'active-job')).not.toBe(computeInputHash(first, 'active-job'));
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

  it('gates realistic plugin-shaped registration cost under 90 seconds projected to 600k', () => {
    const recordSizes = [5_000, 25_000, 50_000];
    const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const makeJob = (id: string, index: number) => {
      const size = recordSizes[index % recordSizes.length];
      const localizedDescription = repeat(
        `Descrizione lunga del ruolo ${id}: responsabilità, requisiti e informazioni per il candidato. `,
        Math.floor(size / 4),
      );
      return {
        id,
        slug: `job-${id}`,
        updatedAt: 'fixture-v1',
        title: `Specialista senior ${id}`,
        titleByLocale: {
          it: `Specialista senior ${id}`,
          en: `Senior specialist ${id}`,
          de: `Senior-Spezialist ${id}`,
          fr: `Spécialiste senior ${id}`,
        },
        descriptionByLocale: {
          it: localizedDescription,
          en: localizedDescription,
          de: localizedDescription,
          fr: localizedDescription,
        },
        company: `Company ${index % 37}`,
        companyKey: `company-${index % 37}`,
        location: index % 2 ? 'Lugano' : 'Bellinzona',
        canton: 'TI',
        contract: 'full-time',
        salaryMin: 70_000,
        salaryMax: 95_000,
        currency: 'CHF',
      };
    };
    const primaryJobs = Array.from({ length: 50 }, (_, index) => makeJob(`primary-${index}`, index));
    const relatedPool = Array.from({ length: 30 }, (_, index) => makeJob(`related-${index}`, index + primaryJobs.length));
    const cloneJob = (job: typeof primaryJobs[number]) => ({
      ...job,
      titleByLocale: { ...job.titleByLocale },
      descriptionByLocale: { ...job.descriptionByLocale },
    });
    const callsPerJob = 6;
    const registerCalls = primaryJobs.length * callsPerJob;
    const register = (manifest: IncrementalManifest, call: number, inputCache = null) => {
      const job = cloneJob(primaryJobs[call % primaryJobs.length]);
      const relatedJobs = relatedPool.map(cloneJob);
      const minimalInput = buildMinimalJobInput(job, 'it', job.slug, relatedJobs, inputCache);
      const bridgeNumber = call % callsPerJob;
      manifest.register(
        `/bench/${call}/`,
        'active-job',
        bridgeNumber === 0
          ? minimalInput
          : {
            ...minimalInput,
            bridgeType: bridgeNumber <= 3 ? 'previous-slug' : 'cross-locale',
            path: `/bench/${call}/`,
          },
      );
    };
    const warmupManifest = new IncrementalManifest('it');
    const warmupInputCache = createIncrementalManifestInputCache();
    for (let i = 0; i < 100; i += 1) register(warmupManifest, i, warmupInputCache);

    const manifest = new IncrementalManifest('it');
    const inputCache = createIncrementalManifestInputCache();
    const started = performance.now();
    for (let i = 0; i < registerCalls; i += 1) register(manifest, i, inputCache);
    const elapsedMs = performance.now() - started;
    const projected600kMs = elapsedMs * 600_000 / registerCalls;
    const measuredRecordBytes = primaryJobs.map((job) => JSON.stringify(job).length);
    console.log(
      `incrementalManifest realistic plugin benchmark: ${elapsedMs.toFixed(3)} ms per ${registerCalls} register(); `
      + `projected 600k with 30 related and ${callsPerJob} calls/job: ${projected600kMs.toFixed(3)} ms; `
      + `record bytes=${Math.min(...measuredRecordBytes)}-${Math.max(...measuredRecordBytes)}`,
    );
    expect(manifest.toJSON().counts.total).toBe(registerCalls);
    expect(elapsedMs).toBeGreaterThan(0);
    expect(Math.min(...measuredRecordBytes)).toBeGreaterThanOrEqual(5_000);
    expect(Math.max(...measuredRecordBytes)).toBeLessThanOrEqual(50_500);
    expect(projected600kMs).toBeLessThanOrEqual(90_000);
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
