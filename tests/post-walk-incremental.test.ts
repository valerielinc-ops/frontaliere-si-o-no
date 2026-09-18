import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { IncrementalManifest } from '../build-plugins/shared/incrementalManifest.mjs';
import {
  buildSharedHtmlPathIndex,
  createSharedHtmlPathIndexView,
} from '../build-plugins/shared/htmlPathIndex.mjs';
import { collectHtmlFromClaimedPaths } from '../build-plugins/shared/distHtmlWalk';
import {
  buildPostWalkIncrementalPlanFromState,
  comparePostWalkVerification,
  describePostWalkVerificationPaths,
  loadPostWalkManifestState,
  postWalkIncrementalEnabled,
  releasePostWalkManifestState,
  replacePostWalkPathList,
  selectPostWalkVerificationPaths,
} from '../build-plugins/shared/postWalkIncremental';
import {
  clearPostWalkDerivedDigestCacheForTest,
  loadPostWalkDerivedDigestSidecar,
  loadPostWalkUnmanifestedTopLevels,
  preservePostWalkDerivedOutput,
  writePostWalkDerivedDigestSidecar,
  writePostWalkUnmanifestedTopLevels,
} from '../build-plugins/shared/postWalkDerivedDigest';
import { claim, hashContent, reset as resetWriteRegistry } from '../build-plugins/sharedWriteRegistry';

const BASE_URL = 'https://frontaliereticino.ch';
const ROOT = path.resolve(__dirname, '..');
const roots: string[] = [];

function writeManifest(
  root: string,
  directory: 'incremental-manifest' | 'incremental-manifest-prev',
  entries: ReadonlyArray<{ path: string; kind: string; input: unknown }>,
  includePostWalkMetadata = false,
  emitterFingerprint?: Record<string, string>,
): void {
  const previousFlag = process.env.POST_WALK_INCREMENTAL;
  if (includePostWalkMetadata) process.env.POST_WALK_INCREMENTAL = '1';
  try {
    const manifest = new IncrementalManifest('it');
    if (emitterFingerprint) manifest.setJobsSeoEmitterFingerprint(emitterFingerprint);
    for (const entry of entries) manifest.register(entry.path, entry.kind, entry.input);
    manifest.write(root, path.join(root, '.cache', directory));
  } finally {
    if (previousFlag === undefined) delete process.env.POST_WALK_INCREMENTAL;
    else process.env.POST_WALK_INCREMENTAL = previousFlag;
  }
}

function replaceManifestEntryPath(
  root: string,
  directory: 'incremental-manifest' | 'incremental-manifest-prev',
  sourcePath: string,
  duplicatePath: string,
): void {
  const filePath = path.join(root, '.cache', directory, 'it.jsonl');
  const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n');
  let replaced = false;
  const rewritten = lines.map((line) => {
    const record = JSON.parse(line) as { type?: string; path?: string };
    if (!record.type && record.path === sourcePath && !replaced) {
      replaced = true;
      return JSON.stringify({ ...record, path: duplicatePath });
    }
    return line;
  });
  if (!replaced) throw new Error(`manifest entry not found: ${sourcePath}`);
  fs.writeFileSync(filePath, `${rewritten.join('\n')}\n`, 'utf8');
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
  delete process.env.POST_WALK_INCREMENTAL;
  clearPostWalkDerivedDigestCacheForTest();
  resetWriteRegistry();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('post-walk incremental planning', () => {
  it('rejects duplicate paths in the current streamed manifest', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/previous/', kind: 'active-job', input: { title: 'previous' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/current-a/', kind: 'active-job', input: { title: 'a' } },
      { path: 'jobs/current-b/', kind: 'active-job', input: { title: 'b' } },
    ]);
    replaceManifestEntryPath(
      root,
      'incremental-manifest',
      'jobs/current-b/',
      'jobs/current-a/',
    );

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);

    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) throw new Error('expected duplicate current path to fail closed');
    expect(loaded.reason).toMatch(/path (?:manifest )?duplicato/);
  });

  it('rejects duplicate paths in the previous streamed manifest even when removed', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/removed-a/', kind: 'active-job', input: { title: 'a' } },
      { path: 'jobs/removed-b/', kind: 'active-job', input: { title: 'b' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/stable/', kind: 'active-job', input: { title: 'stable' } },
    ]);
    replaceManifestEntryPath(
      root,
      'incremental-manifest-prev',
      'jobs/removed-b/',
      'jobs/removed-a/',
    );

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);

    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) throw new Error('expected duplicate previous path to fail closed');
    expect(loaded.reason).toMatch(/precedente manifest path duplicato/);
  });

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
      {
        path: 'jobs/changed/',
        kind: 'active-job',
        input: { title: 'old', href: `${BASE_URL}/en/jobs/changed/` },
      },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'stable' } },
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
    ], true);
    writeManifest(root, 'incremental-manifest', [
      {
        path: 'jobs/changed/',
        kind: 'active-job',
        input: { title: 'new', href: `${BASE_URL}/en/jobs/changed/` },
      },
      { path: 'en/jobs/changed/', kind: 'active-job', input: { title: 'stable' } },
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
    ], true);

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      state: loaded.state,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.changed).toBe(1);
    expect(plan.eligibleByManifest).toBe(3);
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

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) throw new Error('expected missing previous manifest');
    expect(loaded.reason).toContain('precedente manifest mancante');

    // A caller that cannot load the pair keeps the exact full process list.
    expect(fs.existsSync(distDir)).toBe(true);
    expect(htmlPaths).toHaveLength(7);
  });

  it('falls back as one unit when the producer fingerprint changes', async () => {
    const root = fixtureRoot();
    const entry = { path: 'jobs/changed/', kind: 'active-job', input: { jobId: 'job-1', title: 'same' } };
    writeManifest(root, 'incremental-manifest-prev', [entry], true, { jobs: 'jobs-seo@old' });
    writeManifest(root, 'incremental-manifest', [entry], true, { jobs: 'jobs-seo@new' });

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);

    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) {
      throw new Error('expected producer fingerprint mismatch to fall back before loading entries');
    }
    expect(loaded.reason).toContain('emitter fingerprint cambiato');
  });

  it('can omit unmanifested paths only for the sampled-verifier plan', async () => {
    const root = fixtureRoot();
    const manifestPath = writeHtml(root, 'jobs/changed/index.html', 'changed');
    const unmanifestedPath = writeHtml(root, 'uncovered/index.html', 'uncovered');
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'old' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'active-job', input: { title: 'new' } },
    ]);
    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlanFromState({
      distDir: path.join(root, 'dist'),
      allHtmlPaths: [manifestPath, unmanifestedPath],
      processableHtmlPaths: [manifestPath, unmanifestedPath],
      existingHtmlSet: new Set([manifestPath, unmanifestedPath]),
      baseUrl: BASE_URL,
      includeUncoveredPaths: false,
      state: loaded.state,
    });

    expect(plan.processHtmlPaths).toEqual([manifestPath]);
    expect(plan.unmanifested).toBe(1);
    expect(plan.unmanifestedSkipped).toBe(1);
  });

  it('classifies sampled paths before the manifest state is released', async () => {
    const root = fixtureRoot();
    const changedPath = writeHtml(root, 'jobs/changed/index.html', 'changed');
    const unchangedPath = writeHtml(root, 'jobs/unchanged/index.html', 'unchanged');
    const uncoveredPath = writeHtml(root, 'blog/article/index.html', 'uncovered');
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/changed/', kind: 'expired-soft-landing', input: { title: 'old' } },
      { path: 'jobs/unchanged/', kind: 'cross-locale-reconciliation', input: { title: 'same' } },
    ], true);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/changed/', kind: 'expired-soft-landing', input: { title: 'new' } },
      { path: 'jobs/unchanged/', kind: 'cross-locale-reconciliation', input: { title: 'same' } },
    ], true);

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    const details = describePostWalkVerificationPaths({
      distDir: path.join(root, 'dist'),
      sampledPaths: [changedPath, unchangedPath, uncoveredPath],
      incrementalProcessPaths: [changedPath],
      state: loaded.state,
    });

    expect(details.get(changedPath)).toMatchObject({
      relativePath: 'jobs/changed/index.html',
      topLevel: 'jobs',
      kind: 'expired-soft-landing',
      reason: 'changed entry selected by manifest delta',
    });
    expect(details.get(unchangedPath)).toMatchObject({
      relativePath: 'jobs/unchanged/index.html',
      topLevel: 'jobs',
      kind: 'cross-locale-reconciliation',
      reason: 'unchanged entry: no changed/added/affected dependency edge',
    });
    expect(details.get(uncoveredPath)).toMatchObject({
      relativePath: 'blog/article/index.html',
      topLevel: 'blog',
      kind: 'unmanifested',
      reason: 'unmanifested: no current HTML manifest entry',
    });
  });

  it('preserves a derived bridge when the upstream input digest is unchanged', () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const filePath = writeHtml(root, 'jobs/bridge.html', '<!DOCTYPE html>bridge');
    const sourcePath = writeHtml(root, 'jobs/bridge/index.html', '<!DOCTYPE html>source');
    process.env.POST_WALK_INCREMENTAL = '1';
    writePostWalkDerivedDigestSidecar(root, new Map([
      ['jobs/bridge.html', {
        path: 'jobs/bridge.html',
        kind: 'bridge',
        inputHash: hashContent('<!DOCTYPE html>source'),
        sourcePath: 'jobs/bridge/index.html',
        sourceHash: hashContent('<!DOCTYPE html>source'),
        templateHash: 'flat-bridge@1',
      }],
    ]));
    clearPostWalkDerivedDigestCacheForTest();
    claim(sourcePath, 'fixture', '<!DOCTYPE html>source');
    claim(filePath, 'fixture', '<!DOCTYPE html>source');

    expect(preservePostWalkDerivedOutput(distDir, filePath, '<!DOCTYPE html>source')).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('<!DOCTYPE html>bridge');
  });

  it('does not preserve a derived bridge when its source dependency changed', () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const filePath = writeHtml(root, 'jobs/bridge.html', '<!DOCTYPE html>bridge');
    const sourcePath = writeHtml(root, 'jobs/bridge/index.html', '<!DOCTYPE html>source-new');
    process.env.POST_WALK_INCREMENTAL = '1';
    writePostWalkDerivedDigestSidecar(root, new Map([
      ['jobs/bridge.html', {
        path: 'jobs/bridge.html',
        kind: 'bridge',
        inputHash: hashContent('<!DOCTYPE html>source'),
        sourcePath: 'jobs/bridge/index.html',
        sourceHash: hashContent('<!DOCTYPE html>source-old'),
        templateHash: 'flat-bridge@1',
      }],
    ]));
    clearPostWalkDerivedDigestCacheForTest();
    claim(sourcePath, 'fixture', '<!DOCTYPE html>source-new');
    claim(filePath, 'fixture', '<!DOCTYPE html>source');

    expect(preservePostWalkDerivedOutput(distDir, filePath, '<!DOCTYPE html>source')).toBe(false);
  });

  it('fails closed on an incomplete derived sidecar footer', () => {
    const root = fixtureRoot();
    writePostWalkDerivedDigestSidecar(root, new Map([
      ['jobs/bridge.html', {
        path: 'jobs/bridge.html',
        kind: 'bridge',
        inputHash: null,
        sourcePath: 'jobs/bridge/index.html',
        sourceHash: null,
        templateHash: 'flat-bridge@1',
      }],
    ]));
    const sidecarPath = path.join(
      root,
      '.cache/incremental-manifest/post-walk-derived-v2.jsonl',
    );
    const lines = fs.readFileSync(sidecarPath, 'utf8').trimEnd().split('\n');
    lines.pop();
    fs.writeFileSync(sidecarPath, `${lines.join('\n')}\n`, 'utf8');
    clearPostWalkDerivedDigestCacheForTest();

    expect(loadPostWalkDerivedDigestSidecar(root)).toEqual(new Map());
  });

  it('rebuilds the HTML inventory from claimed paths plus unmanifested roots', () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const claimed = writeHtml(root, 'jobs/claimed/index.html', 'claimed');
    const targeted = writeHtml(root, 'legacy/a/index.html', 'targeted-a');
    const targetedFlat = writeHtml(root, 'legacy/b.html', 'targeted-b');
    writeHtml(root, 'new-direct/index.html', 'must-not-be-guessed');

    const result = collectHtmlFromClaimedPaths(
      distDir,
      [claimed, claimed, path.join(distDir, 'assets', 'ignored.html')],
      ['legacy'],
    );

    expect(result.claimed).toBe(1);
    expect(result.targeted).toBe(3);
    expect(result.paths).toEqual([
      claimed,
      targeted,
      targetedFlat,
      path.join(distDir, 'new-direct/index.html'),
    ]);
  });

  it('round-trips the targeted-walk inventory and fails closed when absent', () => {
    const root = fixtureRoot();
    expect(loadPostWalkUnmanifestedTopLevels(root)).toBeNull();
    writePostWalkUnmanifestedTopLevels(root, ['legacy', '<root>', 'legacy']);
    expect(loadPostWalkUnmanifestedTopLevels(root)).toEqual(['<root>', 'legacy']);
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

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      state: loaded.state,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.removed).toBe(1);
    expect(plan.fallbackMode).toBe('entry');
    expect(plan.fallbackReason).toContain('rimozione senza kind/jobId risolvibile');
    expect(plan.processHtmlPaths).toEqual([htmlPaths[4], htmlPaths[5], htmlPaths[6]]);
    expect(plan.processHtmlPaths).not.toEqual(htmlPaths);

    const streamed = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(streamed.ok).toBe(true);
    if ('reason' in streamed) throw new Error(streamed.reason);
    const streamedPlan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      state: streamed.state,
    });
    expect(streamedPlan.mode).toBe('incremental');
    expect(streamedPlan.fallbackMode).toBe('entry');
    expect(streamedPlan.processHtmlPaths).toEqual([htmlPaths[4], htmlPaths[5], htmlPaths[6]]);
  });

  it('scans unresolved removal references before omitting unmanifested paths', async () => {
    const root = fixtureRoot();
    const distDir = path.join(root, 'dist');
    const sourcePath = writeHtml(
      root,
      'jobs/unchanged/index.html',
      `<a href="${BASE_URL}/jobs/removed/">removed</a>`,
    );
    const uncoveredPath = writeHtml(root, 'uncovered/index.html', 'uncovered');
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
      { path: 'jobs/removed/', kind: 'active-job', input: { title: 'removed' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/unchanged/', kind: 'active-job', input: { title: 'same' } },
    ]);

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);
    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: [sourcePath, uncoveredPath],
      processableHtmlPaths: [sourcePath, uncoveredPath],
      existingHtmlSet: new Set([sourcePath, uncoveredPath]),
      baseUrl: BASE_URL,
      includeUncoveredPaths: false,
      state: loaded.state,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.fallbackMode).toBe('entry');
    expect(plan.processHtmlPaths).toEqual([sourcePath]);
    expect(plan.processHtmlPaths).not.toContain(uncoveredPath);
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
    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: htmlPaths,
      processableHtmlPaths: htmlPaths,
      baseUrl: BASE_URL,
      state: loaded.state,
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

  it('processes a changed page even when its owned hreflang target is absent', async () => {
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
    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    const plan = buildPostWalkIncrementalPlanFromState({
      distDir,
      allHtmlPaths: [changedPath],
      processableHtmlPaths: [changedPath],
      baseUrl: BASE_URL,
      state: loaded.state,
    });

    expect(plan.mode).toBe('incremental');
    expect(plan.fallbackReason).toBeUndefined();
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

    const affectedComparison = comparePostWalkVerification({
      fullWouldWritePaths: [],
      incrementalProcessPaths: [processed],
      sampledPaths: [],
      affectedWouldWritePaths: [skipped],
      affectedPaths: [processed],
    });
    expect(affectedComparison.wouldWriteButSkipped).toEqual([skipped]);
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
    expect(loaded.state.current.entries.get('jobs/stable')?.postWalk?.jobId)
      .toBe('stable-1');
    expect(loaded.state.current.entries.get('jobs/stable')?.postWalk?.jobIds)
      .toBeUndefined();
    expect(phases).toEqual(['current-loaded', 'previous-loaded']);
    expect('previous' in loaded.state).toBe(false);
  });

  it('releases the manifest projection after the bounded plan is copied', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ], true);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ], true);

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(true);
    if ('reason' in loaded) throw new Error(loaded.reason);

    releasePostWalkManifestState(loaded.state);

    expect(loaded.state.current.entries.size).toBe(0);
    expect(loaded.state.current.kinds.size).toBe(0);
    expect(loaded.state.previousKinds.size).toBe(0);
    expect(loaded.state.changed.size).toBe(0);
    expect(loaded.state.affected.size).toBe(0);
  });

  it('fails closed on a duplicate path in a streamed manifest', async () => {
    const root = fixtureRoot();
    writeManifest(root, 'incremental-manifest-prev', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ]);
    writeManifest(root, 'incremental-manifest', [
      { path: 'jobs/stable/', kind: 'active-job', input: { jobId: 'stable-1' } },
    ]);

    const manifestFile = path.join(root, '.cache', 'incremental-manifest', 'it.jsonl');
    const lines = fs.readFileSync(manifestFile, 'utf8').trimEnd().split('\n');
    const footerLine = lines.pop();
    if (!footerLine) throw new Error('footer manifest mancante nel fixture');
    const footer = JSON.parse(footerLine) as {
      counts: { total: number; byKind: Record<string, number> };
    };
    const duplicateEntry = lines.at(-1);
    if (!duplicateEntry) throw new Error('entry manifest mancante nel fixture');
    footer.counts.total += 1;
    footer.counts.byKind['active-job'] += 1;
    lines.push(duplicateEntry, JSON.stringify(footer));
    fs.writeFileSync(manifestFile, `${lines.join('\n')}\n`, 'utf8');

    const loaded = await loadPostWalkManifestState(root, ['it'], BASE_URL);
    expect(loaded.ok).toBe(false);
    if (!('reason' in loaded)) throw new Error('expected duplicate manifest failure');
    expect(loaded.reason).toContain('corrente manifest path duplicato');
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
    expect(loaded.state.current.entries.get('jobs/referrer')?.postWalk?.references)
      .toBeUndefined();
    expect(phases).toEqual([
      'current-loaded',
      'references-loading',
      'references-loaded',
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
    expect(loaded.state.current.entries.get('jobs/migrated')?.postWalk?.jobId)
      .toBe('shared-job');

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

    const sampleOnly = selectPostWalkVerificationPaths(paths, null, forced, false);
    expect(sampleOnly).toHaveLength(2);
    expect(sampleOnly).not.toContain(paths[99]);
  });

  it('keeps the worker existence oracle exact without cloning path strings', () => {
    const paths = [
      '/synthetic/dist/jobs/citta/index.html',
      '/synthetic/dist/jobs/città/index.html',
      '/synthetic/dist/en/jobs/citta/index.html',
    ];
    const serialized = buildSharedHtmlPathIndex(new Set(paths));
    const index = createSharedHtmlPathIndexView(serialized);

    expect(index.has(paths[0])).toBe(true);
    expect(index.has(paths[1])).toBe(true);
    expect(index.has(paths[2])).toBe(true);
    expect(index.has('/synthetic/dist/jobs/citta/index.htm')).toBe(false);
    expect(index.has('/synthetic/dist/jobs/città/index.htm')).toBe(false);
  });
});
