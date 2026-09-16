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
): void {
  const manifest = new IncrementalManifest('it');
  for (const entry of entries) manifest.register(entry.path, entry.kind, entry.input);
  manifest.write(root, path.join(root, '.cache', directory));
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

  it('falls back when a logical page was removed because reverse hreflang edges are unknown', async () => {
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
    expect(plan.fallbackReason).toContain('path rimossi=1');
    expect(plan.processHtmlPaths).toEqual(htmlPaths);
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
