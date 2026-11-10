import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpiredJobEdgeDatasetWriter } from '../scripts/lib/expired-job-edge-dataset-writer.mjs';

const TEMPLATE = [
  '__FT_EDGE_TITLE__',
  '__FT_EDGE_SOCIAL_TITLE__',
  '__FT_EDGE_DESCRIPTION__',
  '__FT_EDGE_SOCIAL_DESCRIPTION__',
  '__FT_EDGE_CANONICAL_PATH__',
  '__FT_EDGE_HREFLANG__',
  '__FT_EDGE_JSONLD__',
  '__FT_EDGE_DATA__',
  '__FT_EDGE_BODY__',
  '__FT_EDGE_AD_SNIPPET__',
].join('|');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('expired job edge dataset writer', () => {
  it('streams page records into compact shards and activates only requested complete sections', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-job-edge-'));
    tempDirs.push(distDir);
    const writer = createExpiredJobEdgeDatasetWriter({
      distDir,
      locale: 'en',
      generation: 'build-123',
      template: TEMPLATE,
      adSnippetHtml: '<meta name="google-adsense-account">',
      coverage: { complete: true, returnedRows: 123, reportedRows: 123 },
      requestedSections: ['zurigo', 'berna'],
    });

    expect(writer.addPage('/en/find-jobs-zurich/expired-engineer/', 'zurigo', { title: 'Engineer' })).toBe(true);
    expect(writer.addPage('/en/find-jobs-bern/expired-clerk/', 'berna', { title: 'Clerk' })).toBe(true);
    expect(writer.addPage('/en/find-jobs-bern/expired-clerk/', 'invalid/section', { title: 'Ignored' })).toBe(false);

    const { manifest, manifestPath } = writer.finish();
    expect(manifest).toMatchObject({
      locale: 'en',
      generation: 'build-123',
      pageCount: 2,
      availableSections: ['berna', 'zurigo'],
      activeSections: ['berna', 'zurigo'],
      coverage: { complete: true, returnedRows: 123, reportedRows: 123 },
    });
    expect(manifest.shardIds).toHaveLength(2);
    const pages = manifest.shardIds.flatMap((shardId: string) => {
      const shardPath = path.join(path.dirname(manifestPath), manifest.generation, `${shardId}.json`);
      return Object.entries(JSON.parse(fs.readFileSync(shardPath, 'utf8')).pages);
    });
    expect(Object.fromEntries(pages)).toEqual({
      '/en/find-jobs-zurich/expired-engineer/': { title: 'Engineer' },
      '/en/find-jobs-bern/expired-clerk/': { title: 'Clerk' },
    });
    expect(() => writer.finish()).toThrow(/already finished/);
  });

  it('forces the active section list off when evidence coverage is incomplete', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-job-edge-incomplete-'));
    tempDirs.push(distDir);
    const writer = createExpiredJobEdgeDatasetWriter({
      distDir,
      locale: 'it',
      generation: 'build-124',
      template: TEMPLATE,
      coverage: { complete: false, returnedRows: 0, reportedRows: 4 },
      requestedSections: ['zurigo'],
    });
    writer.addPage('/cerca-lavoro-zurigo/expired-engineer/', 'zurigo', { title: 'Ingegnere' });

    expect(writer.finish().manifest.activeSections).toEqual([]);
  });
});
