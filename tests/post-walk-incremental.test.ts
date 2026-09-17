import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { IncrementalManifest } from '../build-plugins/shared/incrementalManifest.mjs';
import {
  buildPostWalkIncrementalPlan,
  buildPostWalkIncrementalPlanFromState,
  comparePostWalkVerification,
  loadPostWalkManifestState,
  loadPostWalkManifestPair,
  postWalkIncrementalEnabled,
  replacePostWalkPathList,
  selectPostWalkVerificationPaths,
} from '../build-plugins/shared/postWalkIncremental';

const BASE_URL = 'https://frontaliereticino.ch';
const ROOT = path.resolve(__dirname, '..');
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

  it('keeps an unresolved removal as a per-entry fallback', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const htmlPaths = collectFixtureHtml(root);
    writeHtml(
      root,
      'jobs/unchanged/index.html',
      `<a href="${BASE_URL}/jobs/removed/">removed</a>`,
    );
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'same' } },
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
      { path: 'jobs/removed/', kind: 'active-job', input: { title: 'removed' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'same' } },
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
    expect(plan.removed).toBe(1);
    expect(plan.fallbackMode).toBe('entry');
    expect(plan.fallbackReason).toContain('rimozione senza kind/jobId risolvibile');
    expect(plan.processHtmlPaths).toEqual([htmlPaths[4], htmlPaths[5], htmlPaths[6]]);
    expect(plan.processHtmlPaths).not.toEqual(htmlPaths);
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

  it('copies large coordinator path lists without overflowing the call stack', () => {
    const moduleUrl = pathToFileURL(
      path.join(ROOT, 'build-plugins/shared/postWalkIncremental.ts'),
    ).href;
    const script = `
      import { replacePostWalkPathList } from ${JSON.stringify(moduleUrl)};
      const source = Array.from({ length: 200_000 }, (_, index) => '/fake/' + index + '/index.html');
      const target = ['/stale/index.html'];
      replacePostWalkPathList(target, source);
      if (target.length !== source.length || target[0] !== source[0] || target.at(-1) !== source.at(-1)) {
        process.exit(1);
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps the incremental flag opt-in', () => {
    const previous = process.env.POST_WALK_INCREMENTAL;
    delete process.env.POST_WALK_INCREMENTAL;
    expect(postWalkIncrementalEnabled()).toBe(false);
    if (previous === undefined) delete process.env.POST_WALK_INCREMENTAL;
    else process.env.POST_WALK_INCREMENTAL = previous;
  });

  it('streams the current projection and previous delta without returning a previous map', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ], true);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ], true);

    const phases: string[] = [];
    const loaded = await loadPostWalkManifestState(
      root,
      ['it'],
      BASE_URL,
      (progress) => phases.push(progress.phase),
    );
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    expect(loaded.state.current.entries.size).toBe(1);
    expect(loaded.state.previousEntryCount).toBe(1);
    expect(phases).toEqual(['current-loaded', 'previous-loaded']);
    expect('previous' in loaded.state).toBe(false);
  });

  it('does a second bounded previous stream for references to an added page', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      {
        path: 'jobs/referrer/',
        kind: 'active-job',
        input: { jobId: 'referrer-1', targetPath: '/jobs/added/' },
      },
    ], true);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/referrer/', kind: 'active-job', input: { jobId: 'referrer-1' } },
      { path: 'jobs/added/', kind: 'active-job', input: { jobId: 'added-1' } },
    ], true);

    const phases: string[] = [];
    const loaded = await loadPostWalkManifestState(
      root,
      ['it'],
      BASE_URL,
      (progress) => phases.push(progress.phase),
    );
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    expect(loaded.state.added).toEqual(new Set(['jobs/added']));
    expect(loaded.state.affected).toEqual(new Set(['jobs/referrer', 'jobs/added']));
    expect(phases).toEqual([
      'current-loaded',
      'previous-references-loading',
      'previous-references-loaded',
      'previous-loaded',
    ]);
  });

  it('preserves previous identity metadata when an unchanged current entry predates the projection', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const changedPath = writeHtml(root, 'jobs/changed/index.html', 'changed');
    const migratedPath = writeHtml(root, 'jobs/migrated/index.html', 'migrated');
    const previousEntries = [
      { path: 'jobs/changed/', kind: 'active-job', input: { jobId: 'shared-job', title: 'old' } },
      { path: 'jobs/migrated/', kind: 'active-job', input: { jobId: 'shared-job', title: 'same' } },
    ];
    writeManifest(root, 'incremental-manifest-prev', previousEntries, true);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { jobId: 'shared-job', title: 'new' } },
      { path: 'jobs/migrated/', kind: 'active-job', input: { jobId: 'shared-job', title: 'same' } },
    ]);

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    expect(loaded.state.current.entries.get('jobs/migrated')?.postWalk?.jobIds)
      .toEqual(['shared-job']);

    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: [changedPath, migratedPath],
      processableHtmlPaths: [changedPath, migratedPath],
      baseUrl: BASE_URL,
      state: loaded.state,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.changed).toBe(1);
    expect(plan.affected).toBe(1);
    expect(plan.processHtmlPaths).toEqual([changedPath, migratedPath]);
  });

  it('selects a deterministic 2% sample and always includes forced affected paths', () => {
    const paths = Array.from({ length: 100 }, (_, index) => `/dist/jobs/${index}/index.html`);
    const forced = [paths[99]];
    const selected = selectPostWalkVerificationPaths(paths, null, forced);
    const reordered = selectPostWalkVerificationPaths([...paths].reverse(), null, forced);

    expect(selected).toHaveLength(3);
    expect(selected).toContain(paths[99]);
    expect(new Set(reordered)).toEqual(new Set(selected));
  });
});
