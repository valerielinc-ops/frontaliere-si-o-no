import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IncrementalManifest } from '../build-plugins/shared/incrementalManifest.mjs';
import {
  buildPostWalkIncrementalPlan,
  comparePostWalkVerification,
  loadPostWalkManifestPair,
  postWalkIncrementalEnabled,
} from '../build-plugins/shared/postWalkIncremental';

const BASE_URL = 'https://frontaliereticino.ch';
const roots: string[] = [];

function writeManifest(
  root: string,
  directory: 'incremental-manifest' | 'incremental-manifest-prev',
  entries: ReadonlyArray<{ path: string; kind: string; input: unknown }>,
  includePostWalkMetadata = false,
): void {
  const previousFlag = process.env.POST_WALK_INCREMENTAL;
  if (includePostWalkMetadata) process.env.POST_WALK_INCREMENTAL = '1';
  try {
    const manifest = new IncrementalManifest('it');
    for (const entry of entries) manifest.register(entry.path, entry.kind, entry.input);
    manifest.write(root, path.join(root, '.cache', directory));
  } finally {
    if (previousFlag === undefined) delete process.env.POST_WALK_INCREMENTAL;
    else process.env.POST_WALK_INCREMENTAL = previousFlag;
  }
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-walk-incremental-'));
  roots.push(root);
  return root;
}

function writeHtml(root: string, relativePath: string, html: string): string {
  const filePath = path.join(root, 'dist', relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
}

function collectFixtureHtml(root: string): string[] {
  const paths = [
    'jobs/changed/index.html',
    'jobs/changed.html',
    'en/jobs/changed/index.html',
    'en/jobs/changed.html',
    'jobs/unchanged/index.html',
    'jobs/unchanged.html',
    'uncovered/index.html',
  ];
  return paths.map((relativePath) => writeHtml(root, relativePath, relativePath));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('post-walk incremental planning', () => {
  it('processes changed and affected aliases while skipping unchanged manifest pages', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const htmlPaths = collectFixtureHtml(root);
    writeHtml(
      root,
      'jobs/changed/index.html',
      `<link rel="alternate" hreflang="en" href="${BASE_URL}/en/jobs/changed/">`,
    );

    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'stable' } },
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'new' } },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'stable' } },
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
    ]);

    const loaded = await loadPostWalkManifestPair(root, ['it']);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlan({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      manifests: loaded.pair,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.changed).toBe(1);
    expect(plan.eligibleByManifest).toBe(6);
    expect(plan.skippedUnchanged).toBe(2);
    expect(plan.affected).toBe(2);
    expect(plan.processHtmlPaths).toEqual([
      htmlPaths[0],
      htmlPaths[1],
      htmlPaths[2],
      htmlPaths[3],
      htmlPaths[6],
    ]);
  });

  it('falls back when the previous manifest is missing', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const htmlPaths = collectFixtureHtml(root);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'new' } },
    ]);

    const loaded = await loadPostWalkManifestPair(root, ['it']);
    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) throw new Error('expected missing previous manifest');
    expect(loaded.reason).toContain('precedente manifest mancante');

    // A caller that cannot load the pair keeps the exact full process list.
    expect(fs.existsSync(distDir)).toBe(true);
    expect(htmlPaths).toHaveLength(7);
  });

  it('falls back when a removed logical page has no resolvable kind/job identity', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const htmlPaths = collectFixtureHtml(root);
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
      { path: 'jobs/removed/', kind: 'active-job', input: { title: 'removed' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
    ]);

    const loaded = await loadPostWalkManifestPair(root, ['it']);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    const plan = buildPostWalkIncrementalPlan({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      manifests: loaded.pair,
    });

    expect(plan.mode).toBe('full');
    expect(plan.removed).toBe(1);
    expect(plan.fallbackReason).toContain('rimozione senza kind/jobId risolvibile');
    expect(plan.processHtmlPaths).toEqual(htmlPaths);
  });

  it('keeps add/remove incremental and selects same-job/explicit dependants among untouched pages', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const untouched = Array.from({ length: 250 }, (_, index) => ({
      path: `jobs/untouched-${index}/`,
      kind: 'active-job',
      input: { jobId: `stable-${index}`, slug: `untouched-${index}` },
    }));
    const previousEntries = [
      { path: 'jobs/changed/', kind: 'active-job', input: { jobId: 'job-1', slug: 'changed', title: 'old' } },
      { path: 'jobs/removed/', kind: 'active-job', input: { jobId: 'job-2', slug: 'removed' } },
      { path: 'jobs/live-same-job/', kind: 'active-job', input: { jobId: 'job-2', slug: 'live-same-job' } },
      { path: 'jobs/referrer/', kind: 'active-job', input: {
        jobId: 'job-3',
        slug: 'referrer',
        targetPath: '/jobs/added/',
      } },
      ...untouched,
    ];
    const currentEntries = [
      { path: 'jobs/changed/', kind: 'active-job', input: { jobId: 'job-1', slug: 'changed', title: 'new' } },
      { path: 'jobs/added/', kind: 'active-job', input: { jobId: 'job-2', slug: 'added' } },
      { path: 'jobs/live-same-job/', kind: 'active-job', input: { jobId: 'job-2', slug: 'live-same-job' } },
      { path: 'jobs/referrer/', kind: 'active-job', input: {
        jobId: 'job-3',
        slug: 'referrer',
        targetPath: '/jobs/added/',
      } },
      ...untouched,
    ];
    const htmlPaths = currentEntries.map((entry) => writeHtml(
      root,
      `${entry.path}index.html`,
      entry.path,
    ));

    writeManifest(root, 'incremental-manifest-prev', previousEntries, true);
    writeManifest(root, 'incremental-manifest', currentEntries, true);
    const loaded = await loadPostWalkManifestPair(root, ['it']);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlan({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      manifests: loaded.pair,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.changed).toBe(1);
    expect(plan.added).toBe(1);
    expect(plan.removed).toBe(1);
    expect(plan.affected).toBe(3);
    expect(plan.processed).toBe(plan.changed + plan.affected);
    expect(plan.skippedUnchanged).toBe(250);
    expect(new Set(plan.processHtmlPaths)).toEqual(new Set([
      path.join(distDir, 'jobs/changed/index.html'),
      path.join(distDir, 'jobs/added/index.html'),
      path.join(distDir, 'jobs/live-same-job/index.html'),
      path.join(distDir, 'jobs/referrer/index.html'),
    ]));
  });

  it('falls back when a changed page has an owned hreflang target outside existingHtmlSet', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const changedPath = writeHtml(
      root,
      'jobs/changed/index.html',
      `<link rel="alternate" hreflang="it" href="${BASE_URL}/jobs/missing/">`,
    );
    const makeEntry = (title: string) => ({ path: 'jobs/changed/', kind: 'active-job', input: { title } });
    writeManifest(root, 'incremental-manifest-prev', [makeEntry('old')]);
    writeManifest(root, 'incremental-manifest', [makeEntry('new')]);
    const loaded = await loadPostWalkManifestPair(root, ['it']);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlan({
      distDir,
      allHtmlPaths: [changedPath],
      processableHtmlPaths: [changedPath],
      baseUrl: BASE_URL,
      manifests: loaded.pair,
    });

    expect(plan.mode).toBe('full');
    expect(plan.fallbackReason).toContain('target hreflang');
    expect(plan.processHtmlPaths).toEqual([changedPath]);
  });

  it('reports a verification mismatch when a skipped path would be written', () => {
    const root = fixtureRoot();
    const skipped = writeHtml(root, 'jobs/unchanged/index.html', 'fixture');
    const processed = writeHtml(root, 'jobs/changed/index.html', 'fixture');
    const comparison = comparePostWalkVerification({
      fullWouldWritePaths: [skipped],
      incrementalProcessPaths: [processed],
      sampledPaths: [skipped, processed],
    });

    expect(comparison.wouldWriteButSkipped).toEqual([skipped]);
    expect(comparison.processedButWouldNotWrite).toEqual([processed]);
  });

  it('keeps the incremental flag opt-in', () => {
    const previous = process.env.POST_WALK_INCREMENTAL;
    delete process.env.POST_WALK_INCREMENTAL;
    expect(postWalkIncrementalEnabled()).toBe(false);
    if (previous === undefined) delete process.env.POST_WALK_INCREMENTAL;
    else process.env.POST_WALK_INCREMENTAL = previous;
  });
});
