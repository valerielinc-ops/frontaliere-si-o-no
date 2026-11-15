// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  changedUrls,
  crawlSitemaps,
  readSitemapSnapshot,
  serializeSnapshotChunks,
  snapshotFromCrawl,
  snapshotUrls,
  writeSnapshotFile,
} from '../scripts/lib/sitemap-crawl.mjs';

const BASE = 'https://frontaliereticino.ch';
const roots: string[] = [];

function tempFile(name = 'snapshot.json'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-snapshot-'));
  roots.push(root);
  return path.join(root, name);
}

function crawlOf(entries: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  return {
    source: 'local',
    host: 'frontaliereticino.ch',
    baseUrl: BASE,
    missing: ['sitemap-edge.xml'],
    records: new Map(Object.entries(entries).map(([key, urls]) => [key, {
      key,
      kind: 'urlset',
      urls,
      digest: `digest-${key}`,
      lastmod: Object.fromEntries(urls.map((url) => [url, '2026-11-15'])),
    }])),
    ...extra,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sitemap snapshot v4 (NDJSON) roundtrip', () => {
  it('reads back the same v3-shaped object the in-memory snapshot has, in stable order', async () => {
    const crawl = crawlOf({
      'sitemap-b.xml': [`${BASE}/b/1/`, `${BASE}/shared/`],
      'sitemap-a.xml': [`${BASE}/a/1/`, `${BASE}/shared/`],
    });
    const file = tempFile();
    const stats = await writeSnapshotFile(file, crawl, { capturedAt: '2026-11-15T00:00:00.000Z' });
    expect(stats).toMatchObject({ sitemaps: 2, urls: 4 });

    const read = readSitemapSnapshot(file);
    const memory = snapshotFromCrawl(crawl);
    expect(read.version).toBe(3);
    expect(read.snapshotFormat).toBe(4);
    expect(read.sitemapFiles).toEqual(['sitemap-a.xml', 'sitemap-b.xml']);
    expect(read.perSitemap).toEqual(memory.perSitemap);
    expect(read.perSitemapDigests).toEqual(memory.perSitemapDigests);
    expect(read.perSitemapLastmod).toEqual(memory.perSitemapLastmod);
    expect(read.missingSitemaps).toEqual(['sitemap-edge.xml']);
    expect(read.capturedAt).toBe('2026-11-15T00:00:00.000Z');
    expect(Object.keys(read.perSitemap)).toEqual(Object.keys(memory.perSitemap));
    // `_allUrls` is not stored; it is derived.
    expect(read).not.toHaveProperty('_allUrls');
    expect([...snapshotUrls(read)].sort()).toEqual(memory._allUrls);
  });

  it('keeps changedUrls() working across a v4 round trip (lastmod and digest changes)', async () => {
    const before = crawlOf({ 'sitemap-a.xml': [`${BASE}/a/1/`] });
    const after = crawlOf({ 'sitemap-a.xml': [`${BASE}/a/1/`, `${BASE}/a/2/`] });
    const fileBefore = tempFile();
    const fileAfter = tempFile();
    await writeSnapshotFile(fileBefore, before);
    await writeSnapshotFile(fileAfter, after);
    expect(changedUrls(readSitemapSnapshot(fileAfter), readSitemapSnapshot(fileBefore)))
      .toEqual(changedUrls(snapshotFromCrawl(after), snapshotFromCrawl(before)));
  });

  it('writes one header line plus one line per sitemap, each valid JSON, newline terminated', async () => {
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-a.xml': [`${BASE}/a/`], 'sitemap-b.xml': [] }));
    const text = fs.readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ version: 4, source: 'local', sitemapFiles: ['sitemap-a.xml', 'sitemap-b.xml'] });
    expect(lines[1]).toMatchObject({ sitemap: 'sitemap-a.xml', urls: [`${BASE}/a/`] });
    expect(lines[2]).toMatchObject({ sitemap: 'sitemap-b.xml', urls: [] });
  });

  it('leaves no temporary file behind on success', async () => {
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-a.xml': [`${BASE}/a/`] }));
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('removes both the temporary and the final file when serialisation fails', async () => {
    const file = tempFile();
    fs.writeFileSync(file, 'stale content that must not survive a failed capture');
    const poisoned = crawlOf({ 'sitemap-a.xml': [`${BASE}/a/`] });
    // A BigInt in lastmod makes JSON.stringify throw while streaming.
    (poisoned.records.get('sitemap-a.xml') as { lastmod: unknown }).lastmod = { x: BigInt(1) };
    await expect(writeSnapshotFile(file, poisoned)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});

describe('sitemap snapshot size bound', () => {
  it('serialises in chunks no larger than the largest single sitemap, never the sum', () => {
    // 400 synthetic sitemaps of 500 URLs each: the whole graph is 200 000 URL
    // entries, but every chunk only ever holds one sitemap.
    const entries: Record<string, string[]> = {};
    for (let s = 0; s < 400; s += 1) {
      entries[`sitemap-${String(s).padStart(3, '0')}.xml`] = Array.from(
        { length: 500 },
        (_, i) => `${BASE}/section-${s}/page-${i}/`,
      );
    }
    const crawl = crawlOf(entries);
    const lengths: number[] = [];
    let total = 0;
    let chunks = 0;
    for (const chunk of serializeSnapshotChunks(crawl)) {
      chunks += 1;
      lengths.push(chunk.length);
      total += chunk.length;
    }
    expect(chunks).toBe(401); // header + one per sitemap
    const largest = Math.max(...lengths);
    expect(largest).toBeLessThan(total / 100);
    // Each entry chunk is itself small and independent of how many sitemaps exist.
    expect(largest).toBeLessThan(100_000);
  });

  it('yields lazily (a consumer can stop early without the rest being serialised)', () => {
    let touched = 0;
    const urls = new Proxy([`${BASE}/a/`], {
      get(target, prop, receiver) {
        if (prop === 'length' || prop === Symbol.iterator || prop === 'toJSON') touched += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const crawl = crawlOf({ 'sitemap-a.xml': [], 'sitemap-b.xml': [] });
    (crawl.records.get('sitemap-b.xml') as { urls: unknown }).urls = urls;
    const iterator = serializeSnapshotChunks(crawl);
    iterator.next(); // header only
    iterator.next(); // sitemap-a
    expect(touched).toBe(0);
  });
});

describe('readSitemapSnapshot', () => {
  it('rejects an absent file explicitly', () => {
    expect(() => readSitemapSnapshot(tempFile())).toThrow(/does not exist \(ENOENT\)/);
  });

  it('rejects a v4 file truncated mid-line', async () => {
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-a.xml': [`${BASE}/a/1/`], 'sitemap-b.xml': [`${BASE}/b/1/`] }));
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.slice(0, text.length - 25));
    expect(() => readSitemapSnapshot(file)).toThrow(/line 3 is not valid JSON/);
  });

  it('rejects a v4 file truncated cleanly at a line boundary (missing sitemaps)', async () => {
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-a.xml': [`${BASE}/a/1/`], 'sitemap-b.xml': [`${BASE}/b/1/`] }));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(file, `${lines[0]}\n${lines[1]}\n`);
    expect(() => readSitemapSnapshot(file)).toThrow(/incomplete: header lists 2 sitemap\(s\), file holds 1/);
  });

  it('rejects an invalid line, a blank line and a repeated sitemap', async () => {
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-a.xml': [`${BASE}/a/1/`] }));
    const [header, entry] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(file, `${header}\n{not json}\n`);
    expect(() => readSitemapSnapshot(file)).toThrow(/line 2 is not valid JSON/);
    fs.writeFileSync(file, `${header}\n\n${entry}\n`);
    expect(() => readSitemapSnapshot(file)).toThrow(/line 2 is empty/);
    fs.writeFileSync(file, `${header}\n${entry}\n${entry}\n`);
    expect(() => readSitemapSnapshot(file)).toThrow(/repeats sitemap sitemap-a.xml/);
  });

  it('rejects an empty file and a non-snapshot document', () => {
    const file = tempFile();
    fs.writeFileSync(file, '');
    expect(() => readSitemapSnapshot(file)).toThrow(/not valid JSON/);
    fs.writeFileSync(file, '"just a string"');
    expect(() => readSitemapSnapshot(file)).toThrow(/not a snapshot document/);
  });

  it('reads legacy single-document v3, v2 and flat v1 snapshots unchanged', () => {
    const file = tempFile();
    const v3 = {
      version: 3,
      sitemapFiles: ['sitemap-a.xml'],
      perSitemap: { 'sitemap-a.xml': [`${BASE}/a/`] },
      perSitemapDigests: { 'sitemap-a.xml': 'd' },
      perSitemapLastmod: { 'sitemap-a.xml': {} },
      missingSitemaps: [],
      _allUrls: [`${BASE}/a/`],
    };
    fs.writeFileSync(file, JSON.stringify(v3));
    expect(readSitemapSnapshot(file)).toEqual(v3);
    fs.writeFileSync(file, JSON.stringify(v3, null, 2)); // multi-line pretty JSON too
    expect(readSitemapSnapshot(file)).toEqual(v3);
    const v2 = { version: 2, perSitemap: { 'sitemap-a.xml': [`${BASE}/a/`] }, _allUrls: [`${BASE}/a/`] };
    fs.writeFileSync(file, JSON.stringify(v2));
    expect(readSitemapSnapshot(file)).toEqual(v2);
    fs.writeFileSync(file, JSON.stringify([`${BASE}/a/`]));
    expect(readSitemapSnapshot(file)).toEqual([`${BASE}/a/`]);
  });

  it('handles lines that straddle read-chunk boundaries and multi-byte characters', async () => {
    // One sitemap larger than the 1 MiB read chunk, with non-ASCII URLs, to
    // exercise the carry-over of partial lines between reads.
    const urls = Array.from({ length: 30_000 }, (_, i) => `${BASE}/città-è-${i}/`);
    const file = tempFile();
    await writeSnapshotFile(file, crawlOf({ 'sitemap-big.xml': urls, 'sitemap-small.xml': [`${BASE}/ü/`] }));
    expect(fs.statSync(file).size).toBeGreaterThan(1 << 20);
    const read = readSitemapSnapshot(file);
    expect(read.perSitemap['sitemap-big.xml']).toEqual(urls);
    expect(read.perSitemap['sitemap-small.xml']).toEqual([`${BASE}/ü/`]);
  });
});

describe('capture-deployed-sitemaps (local source) end to end', () => {
  function makeDist() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-snapshot-dist-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'sitemap.xml'),
      `<?xml version="1.0"?><sitemapindex><sitemap><loc>${BASE}/sitemap-a.xml</loc></sitemap></sitemapindex>`);
    fs.writeFileSync(path.join(root, 'sitemap-a.xml'),
      `<?xml version="1.0"?><urlset><url><loc>${BASE}/a/1/</loc><lastmod>2026-11-15</lastmod></url>` +
      `<url><loc>${BASE}/a/2/</loc></url></urlset>`);
    return root;
  }

  it('does not retain the raw sitemap XML in the crawl records', async () => {
    const crawl = await crawlSitemaps({ source: 'local', rootDir: makeDist(), baseUrl: BASE, strict: false });
    expect(crawl.records.size).toBe(2);
    for (const record of crawl.records.values()) expect(record).not.toHaveProperty('xml');
  });

  it('writes a v4 file at OUTPUT that the shared reader returns', () => {
    const dist = makeDist();
    const out = tempFile('new-sitemap-urls.json');
    const result = spawnSync(process.execPath, [path.resolve('scripts/capture-deployed-sitemaps.mjs')], {
      env: { PATH: process.env.PATH ?? '', SOURCE: 'local', LOCAL_ROOT: dist, OUTPUT: out },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Captured 2 URL entries across 2 sitemap files');
    const snapshot = readSitemapSnapshot(out);
    expect(snapshot.sitemapFiles).toEqual(['sitemap-a.xml', 'sitemap.xml']);
    expect([...snapshotUrls(snapshot)].sort()).toEqual([`${BASE}/a/1/`, `${BASE}/a/2/`]);
    // Local captures omit the duplicate per-URL lastmod index; the v4 reader
    // keeps the in-memory shape stable with an empty map for each sitemap.
    expect(snapshot.perSitemapLastmod).toEqual({ 'sitemap-a.xml': {}, 'sitemap.xml': {} });
  });

  it('keeps the local snapshot compact without changing the URL set', async () => {
    const crawl = await crawlSitemaps({ source: 'local', rootDir: makeDist(), baseUrl: BASE, strict: false });
    const out = tempFile('compact-snapshot.ndjson');
    await writeSnapshotFile(out, crawl, { includeDerivedIndexes: false });

    const snapshot = readSitemapSnapshot(out);
    expect([...snapshotUrls(snapshot)].sort()).toEqual([`${BASE}/a/1/`, `${BASE}/a/2/`]);
    expect(snapshot.perSitemapLastmod).toEqual({ 'sitemap-a.xml': {}, 'sitemap.xml': {} });
  });

  it('exits non-zero and leaves no OUTPUT when the capture fails', () => {
    const out = tempFile('new-sitemap-urls.json');
    fs.writeFileSync(out, 'stale');
    const result = spawnSync(process.execPath, [path.resolve('scripts/capture-deployed-sitemaps.mjs')], {
      env: { PATH: process.env.PATH ?? '', SOURCE: 'local', LOCAL_ROOT: path.join(path.dirname(out), 'does-not-exist'), OUTPUT: out },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Sitemap snapshot failed');
    expect(fs.existsSync(out)).toBe(false);
  });
});
