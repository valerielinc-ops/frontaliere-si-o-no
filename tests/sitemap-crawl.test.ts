import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changedUrls,
  crawlSitemaps,
  parseSitemapXml,
  snapshotFromCrawl,
} from '../scripts/lib/sitemap-crawl.mjs';

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

    await expect(crawlSitemaps({ baseUrl: BASE, strict: true }))
      .rejects.toThrow('sitemap-cantons.xml');
  });

  it('fails closed when the master sitemap itself is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));

    await expect(crawlSitemaps({ baseUrl: BASE, strict: true }))
      .rejects.toThrow('Sitemap crawl incomplete');
  });
});
