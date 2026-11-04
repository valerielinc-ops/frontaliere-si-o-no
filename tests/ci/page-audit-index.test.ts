// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeIncrementalPageAudit, loadPublisherPageIndex } from '../../scripts/ci/page-audit-index.mjs';

const roots: string[] = [];
const sha = (letter: string) => letter.repeat(64);

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-audit-index-'));
  roots.push(root);
  return root;
}

function makeEntries(count = 64) {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://frontaliereticino.ch/en/jobs-im-tessin/${index}/`,
    path: `en/jobs-im-tessin/${index}/index.html`,
    sha256: sha('a'),
    locale: 'en',
    section: 'ticino',
    family: 'jobs',
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('publisher page audit index', () => {
  it('merges final shard digests into the source page index', () => {
    const root = tempRoot();
    const pages = path.join(root, 'pages');
    const sections = path.join(root, 'sections');
    fs.mkdirSync(pages);
    fs.mkdirSync(sections);
    fs.writeFileSync(path.join(pages, 'en.json'), JSON.stringify({
      kind: 'publisher-page-manifest', schemaVersion: 2, locale: 'en',
      entries: [{ url: 'https://frontaliereticino.ch/en/jobs-im-tessin/', path: 'en/jobs-im-tessin/index.html', sha256: sha('a'), locale: 'en', section: 'ticino' }],
    }));
    fs.writeFileSync(path.join(sections, 'en.json'), JSON.stringify({
      kind: 'publisher-section-manifest', schemaVersion: 2, locale: 'en',
      shards: [{ locale: 'en', section: 'ticino', pages: [{ url: 'https://frontaliereticino.ch/en/jobs-im-tessin/', path: 'en/jobs-im-tessin/index.html', sha256: sha('b'), locale: 'en', section: 'ticino' }] }],
    }));

    expect(loadPublisherPageIndex({ pageManifestDir: pages, sectionManifestDir: sections })).toEqual([{
      url: 'https://frontaliereticino.ch/en/jobs-im-tessin/',
      path: 'en/jobs-im-tessin/index.html', sha256: sha('b'), locale: 'en', section: 'ticino', family: 'jobs',
    }]);
  });

  it('rejects shard pages absent from the source page manifest', () => {
    const root = tempRoot();
    const pages = path.join(root, 'pages');
    const sections = path.join(root, 'sections');
    fs.mkdirSync(pages);
    fs.mkdirSync(sections);
    fs.writeFileSync(path.join(pages, 'en.json'), JSON.stringify({
      kind: 'publisher-page-manifest', schemaVersion: 2, locale: 'en',
      entries: [{ url: 'https://frontaliereticino.ch/en/known/', path: 'en/known/index.html', sha256: sha('a'), locale: 'en', section: 'ticino' }],
    }));
    fs.writeFileSync(path.join(sections, 'en.json'), JSON.stringify({
      kind: 'publisher-section-manifest', schemaVersion: 2, locale: 'en',
      shards: [{ locale: 'en', section: 'ticino', pages: [{ url: 'https://frontaliereticino.ch/en/extra/', path: 'en/extra/index.html', sha256: sha('b'), locale: 'en', section: 'ticino' }] }],
    }));

    expect(() => loadPublisherPageIndex({ pageManifestDir: pages, sectionManifestDir: sections }))
      .toThrow('section page is absent from source page index');
  });

  it('scans the complete population without receipts, then rotates and invalidates by digest', () => {
    const root = tempRoot();
    const receiptFile = path.join(root, 'receipt.json');
    const entries = makeEntries();
    const scanned = new Set<string>();
    const scanBucket = (bucket: typeof entries) => {
      for (const entry of bucket) scanned.add(entry.url);
      return { urls: bucket.map((entry) => entry.url) };
    };

    const first = executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v1', entries, receiptFile, sampleRate: 0.25, scanBucket });
    expect(first.scannedPages).toBe(entries.length);
    expect(first.reusedPages).toBe(0);

    scanned.clear();
    const rotated = executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v1', entries, receiptFile, sampleRate: 0.25, sampleSalt: 1, scanBucket });
    expect(rotated.reusedPages).toBeGreaterThan(0);
    expect(rotated.scannedPages).toBeLessThan(entries.length);

    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const unchangedGroup = Object.entries(receipt.buckets).find(([key]) => !key.endsWith('|bucket-1'));
    expect(unchangedGroup).toBeDefined();
    const targetUrl = (unchangedGroup![1] as { result: { urls: string[] } }).result.urls[0];
    const changed = entries.map((entry) => entry.url === targetUrl ? { ...entry, sha256: sha('c') } : entry);
    scanned.clear();
    const invalidated = executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v1', entries: changed, receiptFile, sampleRate: 0.25, sampleSalt: 1, scanBucket });
    expect(scanned.has(targetUrl)).toBe(true);
    expect(invalidated.reusedPages).toBeLessThan(rotated.reusedPages);
  });

  it('forces a full scan when the validator version changes or full_scan is set', () => {
    const root = tempRoot();
    const receiptFile = path.join(root, 'receipt.json');
    const entries = makeEntries();
    const scanBucket = (bucket: typeof entries) => ({ count: bucket.length });
    executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v1', entries, receiptFile, sampleRate: 0.25, scanBucket });

    const changedValidator = executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v2', entries, receiptFile, sampleRate: 0.25, sampleSalt: 1, scanBucket });
    expect(changedValidator.scannedPages).toBe(entries.length);
    const forced = executeIncrementalPageAudit({ name: 'test', validatorVersion: 'v2', entries, receiptFile, sampleRate: 0.25, sampleSalt: 2, forceFull: true, scanBucket });
    expect(forced.scannedPages).toBe(entries.length);
    expect(forced.reusedPages).toBe(0);
  });
});
