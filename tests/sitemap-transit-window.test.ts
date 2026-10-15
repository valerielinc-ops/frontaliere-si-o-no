/**
 * The two halves of the #5298 tolerance, pinned on fixtures.
 *
 * `tests/blog-slugs-sitemap-sync.test.ts` runs against the committed corpus,
 * whose state depends on when the last sync landed — so it can only ever
 * demonstrate whichever half happens to be true right now. These fixtures
 * assert both, permanently:
 *
 *   1. a state that is genuinely IN TRANSIT is tolerated, and
 *   2. a state that is genuinely INCOHERENT still fails.
 *
 * Without (2) the tolerance would be indistinguishable from a loosening of the
 * gate, which is precisely what the issue rules out.
 *
 * Every timestamp below is taken from the real commits that produced the
 * report, not invented: the in-transit fixture reproduces `10c8c817`
 * (2026-08-07T07:10Z), where one sync commit removed
 * `rimborsi-730-sostituti-imposta` from routerSwissData.ts while adding its
 * <url> block to sitemap-news.xml.
 */
import { describe, expect, it } from 'vitest';

import {
  IN_TRANSIT_WINDOW_MS,
  MAX_PRODUCER_SKEW_MS,
  frontierOf,
  isInTransit,
  parseSitemapEntries,
  partitionMissingSlugs,
  partitionStaleUrls,
  skewMs,
} from './helpers/sitemapTransitWindow';

const SWISS_URL_BASE: Record<string, string> = {
  it: 'https://frontaliereticino.ch/articoli-svizzera/',
  en: 'https://frontaliereticino.ch/en/swiss-articles/',
  de: 'https://frontaliereticino.ch/de/schweiz-artikel/',
  fr: 'https://frontaliereticino.ch/fr/articles-suisse/',
};

const SWISS_LOC_PATTERNS: Record<string, RegExp> = {
  it: /^https:\/\/frontaliereticino\.ch\/articoli-svizzera\/([^/]+)\/$/,
  en: /^https:\/\/frontaliereticino\.ch\/en\/swiss-articles\/([^/]+)\/$/,
  de: /^https:\/\/frontaliereticino\.ch\/de\/schweiz-artikel\/([^/]+)\/$/,
  fr: /^https:\/\/frontaliereticino\.ch\/fr\/articles-suisse\/([^/]+)\/$/,
};

/** A `<url>` block in the shape sitemap-news.xml actually emits. */
function newsBlock(slug: string, publicationDate: string, lastmodDay: string): string {
  return `
  <url>
    <loc>${SWISS_URL_BASE.it}${slug}/</loc>
    <lastmod>${lastmodDay}</lastmod>
    <xhtml:link rel="alternate" hreflang="it" href="${SWISS_URL_BASE.it}${slug}/" />
    <xhtml:link rel="alternate" hreflang="en" href="${SWISS_URL_BASE.en}${slug}-en/" />
    <news:news>
      <news:publication_date>${publicationDate}</news:publication_date>
    </news:news>
  </url>`;
}

/** A `<url>` block in the shape sitemap-blog-ch.xml actually emits. */
function sectionBlock(slug: string, lastmod: string): string {
  return `
  <url>
    <loc>${SWISS_URL_BASE.it}${slug}/</loc>
    <xhtml:link rel="alternate" hreflang="it" href="${SWISS_URL_BASE.it}${slug}/" />
    <xhtml:link rel="alternate" hreflang="en" href="${SWISS_URL_BASE.en}${slug}-en/" />
    <lastmod>${lastmod}</lastmod>
  </url>`;
}

const wrap = (blocks: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${blocks}\n</urlset>`;

describe('parseSitemapEntries keeps each URL with its own clock', () => {
  it('associates loc, hreflang hrefs and timestamp per <url> block', () => {
    const entries = parseSitemapEntries(wrap(
      sectionBlock('vecchio', '2026-06-01') + sectionBlock('nuovo', '2026-08-07T05:27:14.916Z'),
    ));
    expect(entries).toHaveLength(2);
    expect(entries[0].loc).toBe(`${SWISS_URL_BASE.it}vecchio/`);
    expect(entries[0].timestamp).toBe('2026-06-01');
    expect(entries[1].hreflang.en).toBe(`${SWISS_URL_BASE.en}nuovo-en/`);
    expect(entries[1].timestamp).toBe('2026-08-07T05:27:14.916Z');
  });

  it('prefers news:publication_date over lastmod — every lastmod in sitemap-news.xml carries the same build DAY', () => {
    // Measured on the committed file: 23 <url> blocks, one distinct <lastmod>.
    // Dating an entry by <lastmod> there would date all of them identically.
    const [entry] = parseSitemapEntries(wrap(
      newsBlock('rimborsi-730-sostituti-imposta', '2026-08-07T04:42:27.732Z', '2026-08-07'),
    ));
    expect(entry.timestamp).toBe('2026-08-07T04:42:27.732Z');
  });
});

describe('frontierOf picks the newest instant, and refuses to guess', () => {
  it('returns the newest parseable value regardless of input order', () => {
    expect(frontierOf(['2026-08-05T10:44:20.172Z', '2026-08-07T05:27:14.916Z', '2026-06-02']))
      .toBe('2026-08-07T05:27:14.916Z');
  });

  it('skips unparseable and missing values', () => {
    expect(frontierOf([undefined, 'not-a-date', '2026-08-01'])).toBe('2026-08-01');
  });

  it('returns undefined when nothing parses — callers must then tolerate nothing', () => {
    expect(frontierOf([undefined, 'not-a-date'])).toBeUndefined();
  });
});

describe('isInTransit tolerates only the leading edge', () => {
  const frontier = '2026-08-07T05:27:14.916Z';

  it('tolerates an item published after the opposing frontier', () => {
    expect(isInTransit('2026-08-07T06:00:00.000Z', frontier)).toBe(true);
  });

  it('tolerates the real 45-minute arrival inversion that produced #5298', () => {
    // rimborsi-730-sostituti-imposta was published at 04:42:27Z and was still
    // absent from a registry whose frontier already stood at 05:27:14Z,
    // because the corpus generates in parallel and arrival order is not
    // publication order.
    expect(isInTransit('2026-08-07T04:42:27.732Z', frontier)).toBe(true);
  });

  it('does NOT tolerate an item just outside the window', () => {
    const justOutside = new Date(Date.parse(frontier) - IN_TRANSIT_WINDOW_MS - 1000).toISOString();
    expect(isInTransit(justOutside, frontier)).toBe(false);
  });

  it('does NOT tolerate an article from months back — the #3012/#3120 shape', () => {
    expect(isInTransit('2026-01-15', frontier)).toBe(false);
    expect(isInTransit('2026-06-02T20:38:18.558Z', frontier)).toBe(false);
  });

  it('fails closed: an undated item is never in transit', () => {
    expect(isInTransit(undefined, frontier)).toBe(false);
    expect(isInTransit('not-a-date', frontier)).toBe(false);
  });

  it('fails closed: with no opposing frontier nothing is in transit', () => {
    expect(isInTransit('2026-08-07T06:00:00.000Z', undefined)).toBe(false);
  });
});

// ─── Half 1: an in-transit state must PASS ───────────────────────────────────
describe('a genuinely in-transit state is tolerated (reproduces commit 10c8c817)', () => {
  // The registry snapshot: it has the 05:27 article but NOT the 04:42 one,
  // because the sync's corpus pull mirrored a nanako tree that had not
  // received it yet. That is the inversion, verbatim.
  const swissSlugs = {
    'casse-di-disoccupazione': { it: 'casse-di-disoccupazione', en: 'casse-di-disoccupazione-en' },
    'calo-disavanzo-cantonale-2026': { it: 'calo-disavanzo-cantonale-2026', en: 'calo-disavanzo-cantonale-2026-en' },
  };
  const dates = new Map([
    ['casse-di-disoccupazione', '2026-08-07T05:27:14.916Z'],
    ['calo-disavanzo-cantonale-2026', '2026-08-05T10:44:20.172Z'],
  ]);
  const registryFrontier = frontierOf([...dates.values()]);

  it('a sitemap URL the registry snapshot has not received yet is not reported', () => {
    const xml = wrap(
      newsBlock('casse-di-disoccupazione', '2026-08-07T05:27:14.916Z', '2026-08-07')
      + newsBlock('rimborsi-730-sostituti-imposta', '2026-08-07T04:42:27.732Z', '2026-08-07'),
    );
    const validSlugs = { it: new Set(['casse-di-disoccupazione', 'calo-disavanzo-cantonale-2026']), en: new Set(['casse-di-disoccupazione-en', 'calo-disavanzo-cantonale-2026-en']), de: new Set<string>(), fr: new Set<string>() };

    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs,
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier,
    });

    expect(reported).toEqual([]);
    // Non-vacuous: the URLs really were unresolvable, they were excused.
    expect(inTransit.length).toBeGreaterThan(0);
    expect(inTransit.join('\n')).toContain('rimborsi-730-sostituti-imposta');
  });

  it('a registry slug published past the sitemap frontier is not reported', () => {
    // sitemap-blog-ch.xml's newest swiss entry is 03:42; both registry
    // articles below were published after it (the `feat(article):` commits
    // that added them never touch this file).
    const xml = wrap(sectionBlock('vecchio-ma-presente', '2026-08-07T03:42:43.033Z'));
    const entries = parseSitemapEntries(xml);
    const sitemapFrontier = frontierOf(entries.map(e => e.timestamp));

    const { reported, inTransit } = partitionMissingSlugs({
      slugs: {
        'rimborsi-730-sostituti-imposta': { it: 'rimborsi-730-sostituti-imposta' },
        'lavoro-forzato-catene-svizzere': { it: 'lavoro-forzato-catene-svizzere' },
      },
      dates: new Map([
        ['rimborsi-730-sostituti-imposta', '2026-08-07T04:42:27.683Z'],
        ['lavoro-forzato-catene-svizzere', '2026-08-07T05:35:08.558Z'],
      ]),
      urlBase: SWISS_URL_BASE,
      locUrls: new Set([`${SWISS_URL_BASE.it}vecchio-ma-presente/`]),
      hreflangUrls: new Map(),
      sitemapFrontier,
    });

    expect(reported).toEqual([]);
    expect(inTransit).toHaveLength(2);
  });
});

// ─── Half 2: a real incoherence must still FAIL ──────────────────────────────
describe('a genuine desync is still reported (the gate is narrowed, not loosened)', () => {
  it('#3012 shape: an old article whose renamed slug never reached the sitemap', () => {
    // Sitemap regenerated up to 2026-08-07; the article is from January and
    // its slug is absent. The sitemap moved past it and still lacks it.
    const xml = wrap(sectionBlock('un-articolo-recente', '2026-08-07T05:27:14.916Z'));
    const entries = parseSitemapEntries(xml);

    const { reported, inTransit } = partitionMissingSlugs({
      slugs: { 'stipendio-netto-2026': { it: 'stipendio-netto-frontaliere-2026-v2' } },
      dates: new Map([['stipendio-netto-2026', '2026-01-15']]),
      urlBase: SWISS_URL_BASE,
      locUrls: new Set([`${SWISS_URL_BASE.it}un-articolo-recente/`]),
      hreflangUrls: new Map(),
      sitemapFrontier: frontierOf(entries.map(e => e.timestamp)),
    });

    expect(inTransit).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('stipendio-netto-frontaliere-2026-v2');
  });

  it('#3120 shape: a dead swiss URL left in sitemap-news.xml after a rename', () => {
    // Two days behind the registry frontier — far outside the window, and
    // still inside sitemap-news.xml's own 48h recency window, so this is a
    // case the gate must keep catching.
    const xml = wrap(
      newsBlock('calo-disavanzo-cantonale-2026', '2026-08-05T10:44:20.172Z', '2026-08-07'),
    );
    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: { it: new Set(['tutt-altro-slug']), en: new Set(['tutt-altro-slug-en']), de: new Set<string>(), fr: new Set<string>() },
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier: '2026-08-07T05:27:14.916Z',
    });

    expect(inTransit).toEqual([]);
    // The <loc>, its IT hreflang twin and the EN alternate are all dangling —
    // the same one-article-many-rows shape the real failure reported (5 rows
    // for `rimborsi-730-sostituti-imposta`: loc + it + en + de + fr).
    expect(reported).toHaveLength(3);
    expect(reported.join('\n')).toContain('calo-disavanzo-cantonale-2026');
    expect(reported.some(r => r.includes('<loc>'))).toBe(true);
    expect(reported.some(r => r.includes('hreflang href'))).toBe(true);
  });

  it('an undated sitemap entry is reported even at the leading edge (fail closed)', () => {
    const xml = wrap(`
  <url>
    <loc>${SWISS_URL_BASE.it}senza-data/</loc>
  </url>`);
    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: { it: new Set<string>(), en: new Set<string>(), de: new Set<string>(), fr: new Set<string>() },
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier: '2026-08-07T05:27:14.916Z',
    });
    expect(inTransit).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('published unknown');
  });

  it('with no registry frontier at all, nothing is excused', () => {
    const xml = wrap(newsBlock('qualsiasi', '2026-08-07T04:42:27.732Z', '2026-08-07'));
    const { reported, inTransit } = partitionStaleUrls({
      entries: parseSitemapEntries(xml),
      validSlugs: { it: new Set<string>(), en: new Set<string>(), de: new Set<string>(), fr: new Set<string>() },
      patterns: SWISS_LOC_PATTERNS,
      registryFrontier: undefined,
    });
    expect(inTransit).toEqual([]);
    expect(reported.length).toBeGreaterThan(0);
  });
});

// ─── The window cannot silently become permanent ─────────────────────────────
describe('the producer-skew backstop', () => {
  it('accepts the worst gap ever measured between two sync commits (12.8h)', () => {
    const lag = Math.abs(skewMs('2026-08-06T23:20:07Z', '2026-08-06T10:31:43Z'));
    expect(lag).toBeLessThan(MAX_PRODUCER_SKEW_MS);
  });

  it('rejects a sync that has actually stopped', () => {
    const lag = Math.abs(skewMs('2026-08-07T05:27:14.916Z', '2026-08-01T05:27:14.916Z'));
    expect(lag).toBeGreaterThan(MAX_PRODUCER_SKEW_MS);
  });

  it('the transit window stays far below the skew bound — a lagging sync fails, it is not excused', () => {
    expect(IN_TRANSIT_WINDOW_MS).toBeLessThan(MAX_PRODUCER_SKEW_MS / 10);
  });
});
