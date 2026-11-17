import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedUrlTiers,
  changedUrls,
  crawlSitemaps,
  parseSitemapXml,
  snapshotFromCrawl,
} from '../scripts/lib/sitemap-crawl.mjs';
import { isExpiredJobSitemapKey } from '../scripts/lib/sitemap-family-coverage.mjs';

const BASE = 'https://frontaliereticino.ch';
const temporaryDirectories = new Set<string>();

function makeTemporaryDirectory(prefix: string) {
  const root = process.env.CODEX_SNPTOL_TMP_DIR || tmpdir();
  const directory = mkdtempSync(join(root, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('sitemap graph parser', () => {
  it('extracts nested sitemap references and URL-set alternates', () => {
    const index = parseSitemapXml(
      '<sitemapindex><sitemap><loc>https://frontaliereticino.ch/sitemap-articles.xml</loc></sitemap></sitemapindex>',
      { baseUrl: BASE },
    );
    expect(index.referencedSitemaps).toEqual([`${BASE}/sitemap-articles.xml`]);

    const urlset = parseSitemapXml(
      '<urlset><url><loc>https://frontaliereticino.ch/articolo?a=1&amp;b=2</loc>' +
        '<lastmod>2026-10-22T10:00:00Z</lastmod>' +
        '<xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/article" />' +
        '</url></urlset>',
      { baseUrl: BASE },
    );
    expect(urlset.primaryUrls).toEqual([`${BASE}/articolo?a=1&b=2`]);
    expect(urlset.urls).toEqual([
      `${BASE}/articolo?a=1&b=2`,
      `${BASE}/en/article`,
    ]);
    expect(urlset.lastmod[`${BASE}/en/article`]).toBe('2026-10-22T10:00:00Z');
  });

  it('ignores external links instead of submitting them to IndexNow', () => {
    const result = parseSitemapXml(
      '<urlset><url><loc>https://frontaliereticino.ch/a</loc>' +
        '<xhtml:link rel="alternate" hreflang="en" href="https://example.com/a" />' +
        '</url></urlset>',
      { baseUrl: BASE },
    );
    expect(result.urls).toEqual([`${BASE}/a`]);
  });

  it('rejects an HTML/challenge response instead of recording an empty sitemap', () => {
    expect(() => parseSitemapXml('<html><body>challenge</body></html>', { baseUrl: BASE }))
      .toThrow('Invalid sitemap XML');
  });
});

describe('sitemap change snapshots', () => {
  const crawlSnapshot = (xml: string, lastmod: string, source = 'dist') => snapshotFromCrawl({
    source,
    host: 'frontaliereticino.ch',
    baseUrl: BASE,
    missing: [],
    records: new Map([['sitemap-blog.xml', {
      key: 'sitemap-blog.xml',
      urls: [`${BASE}/articolo`],
      digest: xml,
      lastmod: { [`${BASE}/articolo`]: lastmod },
    }]]),
  });

  it('submits an existing URL when its lastmod changes', () => {
    const previous = crawlSnapshot('same', '2026-10-21');
    const current = crawlSnapshot('changed', '2026-10-22');
    expect(changedUrls(current, previous)).toEqual([`${BASE}/articolo`]);
  });

  it('submits the whole sitemap when XML changes without reliable lastmod data', () => {
    const previous = crawlSnapshot('before', '');
    const current = crawlSnapshot('after', '');
    expect(changedUrls(current, previous)).toEqual([`${BASE}/articolo`]);
  });

  it('submits every URL when the sitemap digest changes beside one URL lastmod', () => {
    const first = `${BASE}/first`;
    const second = `${BASE}/second`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [first, second] },
      perSitemapDigests: { 'sitemap-blog.xml': 'before' },
      perSitemapLastmod: { 'sitemap-blog.xml': { [first]: '2026-10-21', [second]: '2026-10-21' } },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [first, second] },
      perSitemapDigests: { 'sitemap-blog.xml': 'after' },
      perSitemapLastmod: { 'sitemap-blog.xml': { [first]: '2026-10-22', [second]: '2026-10-21' } },
    };
    expect(changedUrls(current, previous)).toEqual([first, second]);
  });

  it('does not mistake edge-owned files absent from a local build for removals', () => {
    const previous = {
      version: 3,
      source: 'live',
      perSitemap: {
        'sitemap-blog.xml': [`${BASE}/articolo`],
        'sitemap-articles-canton-ti.xml': [`${BASE}/ti/articolo`],
      },
      perSitemapDigests: {
        'sitemap-blog.xml': 'same',
        'sitemap-articles-canton-ti.xml': 'same',
      },
      perSitemapLastmod: {
        'sitemap-blog.xml': { [`${BASE}/articolo`]: '2026-10-22' },
        'sitemap-articles-canton-ti.xml': { [`${BASE}/ti/articolo`]: '2026-10-22' },
      },
    };
    const current = crawlSnapshot('same', '2026-10-22');
    expect(changedUrls(current, previous, { includeRemoved: false })).toEqual([]);
  });

  it('includes removals from owned sitemap files without inventing edge-file removals', () => {
    const previous = {
      version: 3,
      perSitemap: {
        'sitemap-blog.xml': [`${BASE}/articolo`, `${BASE}/ritirato`],
        'sitemap-articles-canton-ti.xml': [`${BASE}/ti/articolo`],
      },
      perSitemapDigests: {
        'sitemap-blog.xml': 'old-blog',
        'sitemap-articles-canton-ti.xml': 'same',
      },
      perSitemapLastmod: {
        'sitemap-blog.xml': {},
        'sitemap-articles-canton-ti.xml': { [`${BASE}/ti/articolo`]: '2026-10-22' },
      },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [`${BASE}/articolo`] },
      perSitemapDigests: { 'sitemap-blog.xml': 'new-blog' },
      perSitemapLastmod: { 'sitemap-blog.xml': {} },
    };

    expect(changedUrls(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
    })).toEqual([`${BASE}/articolo`, `${BASE}/ritirato`]);
  });

  it('does not infer lastmod changes when either sitemap lastmod map is empty', () => {
    const url = `${BASE}/articolo`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [url] },
      perSitemapDigests: { 'sitemap-blog.xml': 'same' },
      perSitemapLastmod: { 'sitemap-blog.xml': { [url]: '2026-10-21' } },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [url] },
      perSitemapDigests: { 'sitemap-blog.xml': 'same' },
      perSitemapLastmod: { 'sitemap-blog.xml': {} },
    };

    expect(changedUrls(current, previous)).toEqual([]);
    expect(changedUrlTiers(current, previous).lastmod).toEqual([]);
  });

  it('places a real per-URL lastmod change in the lastmod tier', () => {
    const url = `${BASE}/articolo`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [url] },
      perSitemapDigests: { 'sitemap-blog.xml': 'same' },
      perSitemapLastmod: { 'sitemap-blog.xml': { [url]: '2026-10-21' } },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-blog.xml': [url] },
      perSitemapDigests: { 'sitemap-blog.xml': 'same' },
      perSitemapLastmod: { 'sitemap-blog.xml': { [url]: '2026-10-22' } },
    };

    expect(changedUrls(current, previous)).toEqual([url]);
    expect(changedUrlTiers(current, previous).lastmod).toEqual([url]);
  });

  it('keeps changedUrlTiers equivalent to changedUrls across snapshot change classes', () => {
    const known = `${BASE}/known/`;
    const added = `${BASE}/added/`;
    const removed = `${BASE}/removed/`;
    const moved = `${BASE}/moved/`;
    const stayedOne = `${BASE}/stayed-one/`;
    const stayedTwo = `${BASE}/stayed-two/`;
    const digestUrl = `${BASE}/digest/`;
    const lastmodUrl = `${BASE}/lastmod/`;
    const legacyOnly = `${BASE}/legacy-only/`;
    const opts = { includeRemoved: true, includeRemovedFromMissingSitemaps: false };
    const snapshot = (perSitemap: Record<string, string[]>, digests: Record<string, string>, lastmods: Record<string, Record<string, string>> = {}) => ({
      version: 3,
      perSitemap,
      perSitemapDigests: digests,
      perSitemapLastmod: lastmods,
    });
    const fixtures = [
      {
        name: 'addition',
        current: snapshot({ 'sitemap-a.xml': [known, added] }, { 'sitemap-a.xml': 'same' }),
        previous: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }),
      },
      {
        name: 'removal',
        current: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }),
        previous: snapshot({ 'sitemap-a.xml': [known, removed] }, { 'sitemap-a.xml': 'same' }),
      },
      {
        name: 'URL moved between shards with changed digests',
        current: snapshot({
          'sitemap-expired-001.xml': [stayedOne],
          'sitemap-expired-002.xml': [moved, stayedTwo],
        }, { 'sitemap-expired-001.xml': 'new-a', 'sitemap-expired-002.xml': 'new-b' }),
        previous: snapshot({
          'sitemap-expired-001.xml': [moved, stayedOne],
          'sitemap-expired-002.xml': [stayedTwo],
        }, { 'sitemap-expired-001.xml': 'old-a', 'sitemap-expired-002.xml': 'old-b' }),
      },
      {
        name: 'new sitemap',
        current: snapshot({ 'sitemap-a.xml': [known], 'sitemap-new.xml': [added] }, { 'sitemap-a.xml': 'same', 'sitemap-new.xml': 'new' }),
        previous: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }),
      },
      {
        name: 'missing sitemap with missing-sitemap removals excluded',
        current: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }),
        previous: snapshot({ 'sitemap-a.xml': [known], 'sitemap-retired.xml': [removed] }, { 'sitemap-a.xml': 'same', 'sitemap-retired.xml': 'old' }),
      },
      {
        name: 'digest change',
        current: snapshot({ 'sitemap-a.xml': [digestUrl] }, { 'sitemap-a.xml': 'new' }),
        previous: snapshot({ 'sitemap-a.xml': [digestUrl] }, { 'sitemap-a.xml': 'old' }),
      },
      {
        name: 'lastmod change',
        current: snapshot({ 'sitemap-a.xml': [lastmodUrl] }, { 'sitemap-a.xml': 'same' }, { 'sitemap-a.xml': { [lastmodUrl]: '2026-10-22' } }),
        previous: snapshot({ 'sitemap-a.xml': [lastmodUrl] }, { 'sitemap-a.xml': 'same' }, { 'sitemap-a.xml': { [lastmodUrl]: '2026-10-21' } }),
      },
      {
        name: 'lastmod omitted on one side',
        current: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }, { 'sitemap-a.xml': {} }),
        previous: snapshot({ 'sitemap-a.xml': [known] }, { 'sitemap-a.xml': 'same' }, { 'sitemap-a.xml': { [known]: '2026-10-21' } }),
      },
      {
        name: 'version-two legacy baseline',
        current: snapshot({ 'sitemap-a.xml': [known, added] }, { 'sitemap-a.xml': 'new' }),
        previous: { version: 2, perSitemap: { 'sitemap-a.xml': [known] } },
      },
      {
        name: 'flat legacy baseline',
        current: snapshot({ 'sitemap-a.xml': [known, added] }, { 'sitemap-a.xml': 'new' }),
        previous: [known, legacyOnly],
      },
    ];

    for (const fixture of fixtures) {
      const tiers = changedUrlTiers(fixture.current, fixture.previous, opts);
      const grouped = [
        ...tiers.added,
        ...tiers.removed,
        ...tiers.movedIntoArchive,
        ...tiers.movedOutOfArchive,
        ...tiers.lastmod,
        ...Object.values(tiers.digestBySitemap).flat(),
        ...tiers.addedArchive,
      ];
      expect(new Set(grouped).size, fixture.name).toBe(grouped.length);
      expect([...new Set(grouped)].sort(), fixture.name).toEqual(changedUrls(fixture.current, fixture.previous, opts));
    }
  });

  it('sends only archive-exclusive new URLs to the final addedArchive tier', () => {
    const archiveUrls = Array.from({ length: 300 }, (_, index) =>
      `${BASE}/annunci/archive-${String(index).padStart(3, '0')}/`);
    const archiveKeys = [1, 2, 3].map((shard) =>
      `sitemap-jobs-expired-${String(shard).padStart(3, '0')}.xml`);
    const sharedUrl = `${BASE}/annunci/shared/`;
    const regularUrls = [`${BASE}/ricerca/new-z/`, `${BASE}/ricerca/new-a/`];
    const current = {
      version: 3,
      perSitemap: {
        [archiveKeys[0]]: archiveUrls.slice(0, 100),
        [archiveKeys[1]]: archiveUrls.slice(100, 200),
        [archiveKeys[2]]: archiveUrls.slice(200),
        'sitemap-jobs-active.xml': [...regularUrls, sharedUrl],
      },
      perSitemapDigests: Object.fromEntries([...archiveKeys, 'sitemap-jobs-active.xml'].map((key) => [key, 'current'])),
    };
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'previous' },
    };

    const tiers = changedUrlTiers(current, previous, {
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.added).toEqual([...regularUrls, sharedUrl].sort());
    expect(tiers.addedArchive).toEqual(archiveUrls);
    expect([...tiers.added, ...tiers.addedArchive].sort()).toEqual(changedUrls(current, previous));
  });

  it('keeps a new URL shared by archive and regular sitemaps in added', () => {
    const sharedUrl = `${BASE}/annunci/shared-new/`;
    const current = {
      version: 3,
      perSitemap: {
        'sitemap-jobs-expired-001.xml': [sharedUrl],
        'sitemap-jobs-active.xml': [sharedUrl],
      },
      perSitemapDigests: {
        'sitemap-jobs-expired-001.xml': 'expired',
        'sitemap-jobs-active.xml': 'active',
      },
    };
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'previous' },
    };

    const tiers = changedUrlTiers(current, previous, {
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.added).toEqual([sharedUrl]);
    expect(tiers.addedArchive).toEqual([]);
  });

  it('fails closed when the missing sitemaps differ between the snapshots and keeps the stable baseline', () => {
    const archiveOnlyUrl = `${BASE}/annunci/maybe-in-missing-sitemap/`;
    const build = (missingSitemaps: string[] | undefined, withArchive: boolean) => ({
      version: 3,
      perSitemap: withArchive
        ? { 'sitemap-jobs-expired-001.xml': [archiveOnlyUrl], 'sitemap-jobs-active.xml': [] }
        : { 'sitemap-jobs-active.xml': [] },
      perSitemapDigests: withArchive
        ? { 'sitemap-jobs-expired-001.xml': 'expired', 'sitemap-jobs-active.xml': 'active' }
        : { 'sitemap-jobs-active.xml': 'previous' },
      ...(missingSitemaps === undefined ? {} : { missingSitemaps }),
    });
    const opts = { digestIgnoredSitemap: isExpiredJobSitemapKey };

    const cases = [
      { name: 'missing only in current', current: ['sitemap.xml'], previous: undefined, closed: true },
      { name: 'missing only in previous', current: undefined, previous: ['sitemap.xml'], closed: true },
      { name: 'different sets', current: ['sitemap.xml'], previous: ['sitemap-cantons.xml'], closed: true },
      { name: 'identical stable baseline', current: ['sitemap-cantons.xml'], previous: ['sitemap-cantons.xml'], closed: false },
      { name: 'identical unknown gap', current: ['sitemap.xml'], previous: ['sitemap.xml'], closed: true },
      { name: 'no missing sitemaps', current: [], previous: [], closed: false },
    ];
    for (const testCase of cases) {
      const current = build(testCase.current, true);
      const previous = build(testCase.previous, false);
      const tiers = changedUrlTiers(current, previous, opts);
      if (testCase.closed) {
        expect(tiers.addedArchive, testCase.name).toEqual([]);
        expect(tiers.added, testCase.name).toEqual([archiveOnlyUrl]);
      } else {
        expect(tiers.addedArchive, testCase.name).toEqual([archiveOnlyUrl]);
        expect(tiers.added, testCase.name).toEqual([]);
      }
      // The flat list always carries the same URLs; only the archive-last order depends on the split.
      expect(changedUrls(current, previous, opts), testCase.name).toEqual([archiveOnlyUrl]);
    }
  });

  it('keeps added unchanged when the archive classifier or current membership is missing', () => {
    const archiveUrl = `${BASE}/annunci/new-expired/`;
    const normalUrl = `${BASE}/ricerca/new/`;
    const current = {
      version: 3,
      perSitemap: {
        'sitemap-jobs-expired-001.xml': [archiveUrl],
        'sitemap-jobs-active.xml': [normalUrl],
      },
      perSitemapDigests: {
        'sitemap-jobs-expired-001.xml': 'expired',
        'sitemap-jobs-active.xml': 'active',
      },
    };
    const previous = {
      version: 3,
      perSitemap: {},
      perSitemapDigests: {},
    };
    const expectedAdded = changedUrls(current, previous);

    const withoutClassifier = changedUrlTiers(current, previous);
    const invalidClassifier = changedUrlTiers(current, previous, {
      digestIgnoredSitemap: 'not-a-function',
    });
    const withoutCurrentMembership = changedUrlTiers(
      [archiveUrl, normalUrl],
      previous,
      { digestIgnoredSitemap: isExpiredJobSitemapKey },
    );

    expect(withoutClassifier.addedArchive).toEqual([]);
    expect(withoutClassifier.added).toEqual(expectedAdded);
    expect(invalidClassifier.addedArchive).toEqual([]);
    expect(invalidClassifier.added).toEqual(expectedAdded);
    expect(withoutCurrentMembership.addedArchive).toEqual([]);
    expect(withoutCurrentMembership.added).toEqual(expectedAdded);
  });

  it('appends archive-only additions to the flat changedUrls result', () => {
    const archiveUrls = [`${BASE}/annunci/archive-b/`, `${BASE}/annunci/archive-a/`].sort();
    const normalUrl = `${BASE}/ricerca/new/`;
    const current = {
      version: 3,
      perSitemap: {
        'sitemap-jobs-expired-001.xml': archiveUrls,
        'sitemap-jobs-active.xml': [normalUrl],
      },
      perSitemapDigests: {
        'sitemap-jobs-expired-001.xml': 'expired',
        'sitemap-jobs-active.xml': 'active',
      },
    };
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'previous' },
    };
    const flat = changedUrls(current, previous, {
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(flat).toEqual([normalUrl, ...archiveUrls]);
    expect([...flat].sort()).toEqual(changedUrls(current, previous));
  });

  it('suppresses only changed expired-archive digests and counts their URLs', () => {
    const urls = Array.from({ length: 10 }, (_, index) => `${BASE}/expired/${index}/`);
    const previousPer: Record<string, string[]> = {};
    const currentPer: Record<string, string[]> = {};
    const previousDigests: Record<string, string> = {};
    const currentDigests: Record<string, string> = {};
    const previousLastmods: Record<string, Record<string, string>> = {};
    const currentLastmods: Record<string, Record<string, string>> = {};
    for (let shard = 0; shard < 5; shard += 1) {
      const key = `sitemap-jobs-expired-${String(shard + 1).padStart(3, '0')}.xml`;
      previousPer[key] = urls.slice(shard * 2, shard * 2 + 2);
      currentPer[key] = [urls[(shard * 2 + 1) % urls.length], urls[(shard * 2 + 2) % urls.length]];
      previousDigests[key] = `old-${shard}`;
      currentDigests[key] = `new-${shard}`;
      previousLastmods[key] = {};
      currentLastmods[key] = {};
    }
    const tiers = changedUrlTiers(
      { version: 3, perSitemap: currentPer, perSitemapDigests: currentDigests, perSitemapLastmod: currentLastmods },
      { version: 3, perSitemap: previousPer, perSitemapDigests: previousDigests, perSitemapLastmod: previousLastmods },
      { includeRemoved: true, includeRemovedFromMissingSitemaps: false, digestIgnoredSitemap: isExpiredJobSitemapKey },
    );

    expect(tiers.added).toEqual([]);
    expect(tiers.removed).toEqual([]);
    expect(tiers.movedIntoArchive).toEqual([]);
    expect(tiers.movedOutOfArchive).toEqual([]);
    expect(tiers.lastmod).toEqual([]);
    expect(tiers.digestBySitemap).toEqual({});
    expect(tiers.suppressedDigest).toEqual({ sitemaps: 5, urls: 10 });
    expect(tiers.added).not.toContain(urls[0]);
    expect(tiers.removed).not.toContain(urls[0]);
  });

  it('prioritizes a graph URL that moves from an active sitemap into the expired archive', () => {
    const url = `${BASE}/annunci/expired/`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'active' },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-004.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-004.xml': 'expired' },
    };
    const tiers = changedUrlTiers(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.movedIntoArchive).toEqual([url]);
    expect(tiers.movedOutOfArchive).toEqual([]);
    expect(tiers.lastmod).toEqual([]);
    expect(Object.values(tiers.digestBySitemap).flat()).not.toContain(url);
  });

  it('ignores a URL that moves only between expired archive shards', () => {
    const url = `${BASE}/annunci/expired/`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-004.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-004.xml': 'shard-004-before' },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-005.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-005.xml': 'shard-005-after' },
    };
    const tiers = changedUrlTiers(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers).toMatchObject({
      added: [],
      removed: [],
      movedIntoArchive: [],
      movedOutOfArchive: [],
      lastmod: [],
      digestBySitemap: {},
      suppressedDigest: { sitemaps: 1, urls: 1 },
    });
  });

  it('prioritizes a graph URL that moves out of the expired archive into an active sitemap', () => {
    const url = `${BASE}/annunci/reactivated/`;
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-004.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-004.xml': 'expired' },
    };
    const current = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'active' },
    };
    const tiers = changedUrlTiers(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.movedIntoArchive).toEqual([]);
    expect(tiers.movedOutOfArchive).toEqual([url]);
    expect(Object.values(tiers.digestBySitemap).flat()).not.toContain(url);
  });

  it('keeps a URL first appearing in the expired archive in addedArchive', () => {
    const url = `${BASE}/annunci/new-expired/`;
    const current = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-004.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-004.xml': 'expired' },
    };
    const previous = {
      version: 3,
      perSitemap: { 'sitemap-jobs-active.xml': [] },
      perSitemapDigests: { 'sitemap-jobs-active.xml': 'active' },
    };
    const tiers = changedUrlTiers(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.added).toEqual([]);
    expect(tiers.addedArchive).toEqual([url]);
    expect(tiers.movedIntoArchive).toEqual([]);
    expect(tiers.movedOutOfArchive).toEqual([]);
    expect(Object.values(tiers.digestBySitemap).flat()).not.toContain(url);
  });

  it('does not mark a URL added when the old snapshot missed one archive shard but lists it elsewhere', () => {
    const sharedUrl = `${BASE}/annunci/shared/`;
    const current = {
      version: 3,
      perSitemap: {
        'sitemap-jobs-active.xml': [sharedUrl],
        'sitemap-jobs-expired-043.xml': [sharedUrl],
        'sitemap-jobs-expired-044.xml': [sharedUrl],
      },
      perSitemapDigests: {
        'sitemap-jobs-active.xml': 'active-current',
        'sitemap-jobs-expired-043.xml': 'archive-043-current',
        'sitemap-jobs-expired-044.xml': 'archive-044-current',
      },
    };
    const previous = {
      version: 3,
      perSitemap: {
        'sitemap-jobs-active.xml': [sharedUrl],
        'sitemap-jobs-expired-043.xml': [sharedUrl],
      },
      perSitemapDigests: {
        'sitemap-jobs-active.xml': 'active-previous',
        'sitemap-jobs-expired-043.xml': 'archive-043-previous',
      },
    };

    const tiers = changedUrlTiers(current, previous, {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.added).toEqual([]);
    expect(tiers.added).not.toContain(sharedUrl);
  });

  it('does not infer archive movement from a legacy baseline without sitemap membership', () => {
    const url = `${BASE}/annunci/legacy/`;
    const current = {
      version: 3,
      perSitemap: { 'sitemap-jobs-expired-004.xml': [url] },
      perSitemapDigests: { 'sitemap-jobs-expired-004.xml': 'expired' },
    };
    const tiers = changedUrlTiers(current, [url], {
      includeRemoved: true,
      includeRemovedFromMissingSitemaps: false,
      digestIgnoredSitemap: isExpiredJobSitemapKey,
    });

    expect(tiers.legacy).toBe(true);
    expect(tiers.movedIntoArchive).toEqual([]);
    expect(tiers.movedOutOfArchive).toEqual([]);
  });
});

describe('sitemap graph availability policy', () => {
  it('cache-busts every live request while keeping crawl and snapshot identities canonical', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.pathname === '/robots.txt') {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap-robots.xml`, { status: 200 }));
      }
      if (url.pathname === '/sitemap.xml') {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-child.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.pathname === '/sitemap-robots.xml' || url.pathname === '/sitemap-child.xml') {
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/pagina${url.pathname === '/sitemap-child.xml' ? '-figlia' : '-robots'}/</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchDelayMs: 0,
      liveCacheBust: 'run-7',
    });
    const snapshot = snapshotFromCrawl(crawl);

    expect(calls).toHaveLength(4);
    expect(calls.every((url) => new URL(url).searchParams.get('cb') === 'run-7')).toBe(true);
    expect(calls.map((url) => new URL(url).pathname)).toContain('/robots.txt');
    expect(Object.keys(snapshot.perSitemap)).toEqual(['sitemap-child.xml', 'sitemap-robots.xml', 'sitemap.xml']);
    expect([...crawl.records.keys()].sort()).toEqual(Object.keys(snapshot.perSitemap));
    expect([...crawl.records.values()].every((record) => !record.url.includes('cb='))).toBe(true);
    expect(JSON.stringify(snapshot.perSitemap)).not.toContain('cb=');
    expect(JSON.stringify([...crawl.records])).not.toContain('cb=');
  });

  it('does not add cache-busting query parameters when liveCacheBust is empty', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.pathname === '/robots.txt') {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap-child.xml`, { status: 200 }));
      }
      if (url.pathname === '/sitemap.xml') {
        return Promise.resolve(new Response('<urlset><url><loc>https://frontaliereticino.ch/home/</loc></url></urlset>', { status: 200 }));
      }
      if (url.pathname === '/sitemap-child.xml') {
        return Promise.resolve(new Response('<urlset><url><loc>https://frontaliereticino.ch/figlia/</loc></url></urlset>', { status: 200 }));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchDelayMs: 0,
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((url) => !new URL(url).searchParams.has('cb'))).toBe(true);
  });

  it('fails closed when a default or robots-discovered seed is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(
          `Sitemap: ${BASE}/sitemap.xml\nSitemap: ${BASE}/sitemap-cantons.xml`,
          { status: 200 },
        ));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.endsWith('/sitemap-pages.xml')) {
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/pagina/</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    await expect(crawlSitemaps({ baseUrl: BASE, strict: true, fetchDelayMs: 0 }))
      .rejects.toThrow('sitemap-cantons.xml');
  });

  it('fails closed when the master sitemap itself is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));

    await expect(crawlSitemaps({ baseUrl: BASE, strict: true, fetchDelayMs: 0 }))
      .rejects.toThrow('Sitemap crawl incomplete');
  });

  it('retries a transient 404 before failing closed', async () => {
    const fetchMock = vi.fn();
    let childAttempts = 0;
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-articles-canton-nw.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.endsWith('/sitemap-articles-canton-nw.xml')) {
        childAttempts += 1;
        if (childAttempts === 1) return Promise.resolve(new Response('not propagated', { status: 404 }));
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/nw/articolo</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchDelayMs: 0,
    });

    expect(childAttempts).toBe(2);
    expect(crawl.missing).toEqual([]);
    expect(crawl.records.get('sitemap-articles-canton-nw.xml')?.urls)
      .toEqual([`${BASE}/nw/articolo`]);
  });

  it('keeps the live edge retry window open through four transient failures', async () => {
    const fetchMock = vi.fn();
    let childAttempts = 0;
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-articles-canton-ti.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.endsWith('/sitemap-articles-canton-ti.xml')) {
        childAttempts += 1;
        if (childAttempts < 5) return Promise.resolve(new Response('edge warming', { status: 404 }));
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/ti/articolo</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchDelayMs: 0,
    });

    expect(childAttempts).toBe(5);
    expect(crawl.missing).toEqual([]);
    expect(crawl.records.get('sitemap-articles-canton-ti.xml')?.urls)
      .toEqual([`${BASE}/ti/articolo`]);
  });

  it('accepts a provider Retry-After hint without weakening fail-closed crawling', async () => {
    const fetchMock = vi.fn();
    let childAttempts = 0;
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-articles-canton-ti.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.endsWith('/sitemap-articles-canton-ti.xml')) {
        childAttempts += 1;
        if (childAttempts === 1) {
          return Promise.resolve(new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0' },
          }));
        }
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/ti/articolo</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchDelayMs: 0,
    });

    expect(childAttempts).toBe(2);
    expect(crawl.missing).toEqual([]);
  });

  it('tolerates an unreachable expired-archive child after cache-busting retries and keeps its parent', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      calls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname === '/robots.txt') {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (pathname === '/sitemap.xml') {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-jobs-expired-044.xml</loc></sitemap>` +
          `<sitemap><loc>${BASE}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (pathname === '/sitemap-jobs-expired-044.xml') {
        return Promise.resolve(new Response('missing', {
          status: 404,
          headers: { 'cf-cache-status': 'MISS', age: '19' },
        }));
      }
      if (pathname === '/sitemap-pages.xml') {
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/pagina-corrente/</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchAttempts: 1,
      fetchDelayMs: 0,
      liveCacheBust: 'run-7',
      tolerateMissing: isExpiredJobSitemapKey,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'retry-1' },
      logger: { warn: vi.fn() },
    });
    const expiredRequests = calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-jobs-expired-044.xml'));

    expect(crawl.toleratedMissing).toEqual([{
      key: 'sitemap-jobs-expired-044.xml',
      parent: 'sitemap.xml',
      status: 404,
      cfCacheStatus: 'MISS',
      age: '19',
    }]);
    expect(crawl.records.get('sitemap-pages.xml')?.urls).toEqual([`${BASE}/pagina-corrente/`]);
    expect(crawl.missing).toEqual([]);
    expect(crawl.missingRequired).toEqual([]);
    expect(expiredRequests).toHaveLength(3);
    expect(new URL(expiredRequests[0]).searchParams.get('cb')).toBe('run-7');
    expect(expiredRequests.slice(1).every((url) => new URL(url).searchParams.get('cb') === 'retry-1')).toBe(true);
    expect(crawl.toleratedMissing[0].key).not.toContain('?cb=');
  });

  it('uses an expired-archive child recovered on cache-busting retry without tolerating it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-jobs-expired-044.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.includes('/sitemap-jobs-expired-044.xml')) {
        if (!new URL(url).searchParams.has('cb')) {
          return Promise.resolve(new Response('not propagated', { status: 404 }));
        }
        return Promise.resolve(new Response(
          `<urlset><url><loc>${BASE}/annunci/recuperato/</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchAttempts: 1,
      fetchDelayMs: 0,
      tolerateMissing: isExpiredJobSitemapKey,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'run-456' },
      logger: { warn: vi.fn() },
    });

    expect(calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-jobs-expired-044.xml'))).toHaveLength(2);
    expect(crawl.records.get('sitemap-jobs-expired-044.xml')?.urls).toEqual([`${BASE}/annunci/recuperato/`]);
    expect(crawl.toleratedMissing).toEqual([]);
    expect(crawl.missing).toEqual([]);
  });

  it('does not retry an unreachable non-archive sitemap', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-news.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    const error = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchAttempts: 1,
      fetchDelayMs: 0,
      tolerateMissing: isExpiredJobSitemapKey,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'run-789' },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Sitemap crawl incomplete: 1 unreachable sitemap(s): sitemap-news.xml');
    const newsRequests = calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-news.xml'));
    expect(newsRequests).toHaveLength(1);
    expect(new URL(newsRequests[0]).searchParams.has('cb')).toBe(false);
  });

  it('lists only the non-archive sitemap when another missing child is tolerated', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-jobs-expired-044.xml</loc></sitemap>` +
          `<sitemap><loc>${BASE}/sitemap-news.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', {
        status: 404,
        headers: { 'cf-cache-status': 'MISS', age: '21' },
      }));
    }));

    const error = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchAttempts: 1,
      fetchDelayMs: 0,
      tolerateMissing: isExpiredJobSitemapKey,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'run-abc' },
      logger: { warn: vi.fn() },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Sitemap crawl incomplete: 1 unreachable sitemap(s): sitemap-news.xml');
    expect(calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-jobs-expired-044.xml'))).toHaveLength(3);
    expect(calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-news.xml'))).toHaveLength(1);
  });

  it('keeps the default fail-closed archive behavior without tolerance or retries', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/robots.txt')) {
        return Promise.resolve(new Response(`Sitemap: ${BASE}/sitemap.xml`, { status: 200 }));
      }
      if (url.endsWith('/sitemap.xml')) {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${BASE}/sitemap-jobs-expired-044.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    }));

    const error = await crawlSitemaps({
      baseUrl: BASE,
      seeds: ['sitemap.xml'],
      strict: true,
      fetchAttempts: 1,
      fetchDelayMs: 0,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'run-default' },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Sitemap crawl incomplete: 1 unreachable sitemap(s): sitemap-jobs-expired-044.xml');
    const archiveRequests = calls.filter((url) => new URL(url).pathname.endsWith('/sitemap-jobs-expired-044.xml'));
    expect(archiveRequests).toHaveLength(1);
    expect(new URL(archiveRequests[0]).searchParams.has('cb')).toBe(false);
  });

  it('keeps local non-strict crawling unchanged when tolerance and retry options are supplied', async () => {
    const rootDir = makeTemporaryDirectory('local-crawl-');
    writeFileSync(join(rootDir, 'sitemap.xml'),
      `<sitemapindex><sitemap><loc>${BASE}/sitemap-jobs-expired-044.xml</loc></sitemap></sitemapindex>`,
      'utf8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const crawl = await crawlSitemaps({
      baseUrl: BASE,
      source: 'local',
      rootDir,
      seeds: ['sitemap.xml'],
      strict: false,
      tolerateMissing: isExpiredJobSitemapKey,
      unreachableRetry: { attempts: 2, delaysMs: [0, 0], cacheBust: 'local' },
      logger: { warn: vi.fn() },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(crawl.missing).toEqual(['sitemap-jobs-expired-044.xml']);
    expect(crawl.toleratedMissing).toEqual([]);
  });
});
