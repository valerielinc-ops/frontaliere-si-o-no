import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changedUrlTiers,
  changedUrls,
  crawlSitemaps,
  parseSitemapXml,
  snapshotFromCrawl,
} from '../scripts/lib/sitemap-crawl.mjs';
import { isExpiredJobSitemapKey } from '../scripts/lib/sitemap-family-coverage.mjs';

const BASE = 'https://frontaliereticino.ch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      ];
      expect(new Set(grouped).size, fixture.name).toBe(grouped.length);
      expect([...new Set(grouped)].sort(), fixture.name).toEqual(changedUrls(fixture.current, fixture.previous, opts));
    }
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

  it('keeps a URL first appearing in the expired archive in the added tier', () => {
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

    expect(tiers.added).toEqual([url]);
    expect(tiers.movedIntoArchive).toEqual([]);
    expect(tiers.movedOutOfArchive).toEqual([]);
    expect(Object.values(tiers.digestBySitemap).flat()).not.toContain(url);
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
});
