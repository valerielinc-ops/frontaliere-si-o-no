/**
 * Guidle nationwide events crawler (#3125): pure parsing/mapping logic only —
 * no live network calls here (see scripts/crawl-guidle-events.mjs header for
 * the live sitemap + JSON-LD + accordion research this is built from).
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  parseSitemapIndexXml,
  extractEventUrlsFromSitemapXml,
  extractEventJsonLdOccurrences,
  summarizeOccurrences,
  extractAddress,
  extractCategory,
  extractPrice,
  parsePriceText,
  extractGeoAndCanton,
  mapDetailPageToLocaleData,
  mapGuidleEvent,
  parseGuidleArgs,
  selectGuidleEntries,
  targetedGuidleResumeIndex,
  classifyUnmappedGuidleDetail,
  guidleDetailFailureAccounting,
  guidleEmptyRunOutcome,
  isUndatedGuidleListing,
} from '../scripts/crawl-guidle-events.mjs';
import { applyDetailFailureReuse } from '../scripts/lib/detail-failure-reuse-policy.mjs';

describe('targeted Guidle catalog refresh', () => {
  it('validates codes without lowercasing case-sensitive Guidle identities', () => {
    expect(parseGuidleArgs(['--ids', 'guidle:AGwng3C,AHtMkZp,AGwng3C', '--dry-run', '--limit=2']))
      .toEqual({ ids: ['AGwng3C', 'AHtMkZp'], dryRun: true, limit: 2 });
    expect(parseGuidleArgs([])).toEqual({ ids: undefined, dryRun: false, limit: undefined });
    for (const args of [['--ids='], ['--ids=AGwng3C,'], ['--ids=../file'], ['--ids=AGwng3C', '--ids=AHtMkZp'], ['--ids']]) {
      expect(() => parseGuidleArgs(args)).toThrow();
    }
  });

  it('keeps normal catalog order and stabilizes targeted order and cursor identity', () => {
    const entries = [['AHtMkZp', '/b'], ['AGwng3C', '/a'], ['Aq91Knx', '/c']];
    expect(selectGuidleEntries(entries).entries).toBe(entries);
    const ids = ['AGwng3C', 'AHtMkZp'];
    const selected = selectGuidleEntries(entries, ids);
    expect(selected.entries.map(([code]) => code)).toEqual(ids);
    expect(selectGuidleEntries([...entries].reverse(), ids).selectionKey).toBe(selected.selectionKey);
    expect(selectGuidleEntries(entries.slice(1), ids).selectionKey).not.toBe(selected.selectionKey);
    expect(targetedGuidleResumeIndex({ selectionKey: selected.selectionKey, nextIndex: 1 }, selected.selectionKey)).toBe(1);
    for (const checkpoint of [null, { selectionKey: 'other', nextIndex: 1 }, { selectionKey: selected.selectionKey, nextIndex: -1 }, { selectionKey: selected.selectionKey, nextIndex: 1.5 }]) {
      expect(targetedGuidleResumeIndex(checkpoint, selected.selectionKey)).toBe(0);
    }
  });

  it('extracts only the explicit ticketing link and keeps it off the public event record', () => {
    const booking = 'https://infomaniak.events/fr-ch/concerts/example/events/123';
    const data = mapDetailPageToLocaleData(buildDetailHtml() + `<a id="ticketingUrl" href="${booking}">Tickets</a>`, 'de');
    expect(data.bookingUrl).toBe(booking);
    const mapped = mapGuidleEvent('AGwng3C', { de: data });
    expect(mapped.bookingUrl).toBe(booking);
    expect(mapped.event).not.toHaveProperty('bookingUrl');
    expect(mapDetailPageToLocaleData(buildDetailHtml() + '<a href="https://127.0.0.1/">Other link</a>', 'de').bookingUrl).toBeUndefined();
  });
});

describe('parseSitemapIndexXml', () => {
  it('extracts gzipped shard URLs', () => {
    const xml = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://www.guidle.com/sitemap1.xml.gz</loc></sitemap>
      <sitemap><loc>https://www.guidle.com/sitemap2.xml.gz</loc></sitemap>
    </sitemapindex>`;
    expect(parseSitemapIndexXml(xml)).toEqual([
      'https://www.guidle.com/sitemap1.xml.gz',
      'https://www.guidle.com/sitemap2.xml.gz',
    ]);
  });

  it('returns [] for missing/empty input', () => {
    expect(parseSitemapIndexXml('')).toEqual([]);
    expect(parseSitemapIndexXml(undefined as unknown as string)).toEqual([]);
  });
});

describe('extractEventUrlsFromSitemapXml', () => {
  it('extracts {code, pathSuffix} for event detail URLs, dedupes by code, skips /print and listing pages', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://www.guidle.com/de/veranstaltungen/zug/stadtfuehrung_AZ3RYEB</loc></url>
      <url><loc>https://www.guidle.com/it/eventi/zugo/visita-guidata_AZ3RYEB</loc></url>
      <url><loc>https://www.guidle.com/de/veranstaltungen/zug/stadtfuehrung_AZ3RYEB/print</loc></url>
      <url><loc>https://www.guidle.com/de/veranstaltungen/alle</loc></url>
      <url><loc>https://www.guidle.com/de/veranstaltungen/luzern/konzert_BX9KLMN</loc></url>
    </urlset>`;
    const out = extractEventUrlsFromSitemapXml(xml);
    expect(out).toEqual([
      { code: 'AZ3RYEB', pathSuffix: '/veranstaltungen/zug/stadtfuehrung_AZ3RYEB' },
      { code: 'BX9KLMN', pathSuffix: '/veranstaltungen/luzern/konzert_BX9KLMN' },
    ]);
  });

  it('returns [] for missing/empty input', () => {
    expect(extractEventUrlsFromSitemapXml('')).toEqual([]);
    expect(extractEventUrlsFromSitemapXml(undefined as unknown as string)).toEqual([]);
  });
});

describe('extractEventJsonLdOccurrences', () => {
  it('normalizes a single-object Event JSON-LD block into a one-item array', () => {
    const html = `<script type="application/ld+json">{"@type":"Event","name":"Test","startDate":"2026-07-04T19:00"}</script>`;
    const occ = extractEventJsonLdOccurrences(html);
    expect(occ).toHaveLength(1);
    expect(occ[0].name).toBe('Test');
  });

  it('flattens an array-of-occurrences Event JSON-LD block (recurring events)', () => {
    const html = `<script type="application/ld+json">[
      {"@type":"Event","name":"Weekly Tour","startDate":"2026-07-04T09:50"},
      {"@type":"Event","name":"Weekly Tour","startDate":"2026-07-11T09:50"}
    ]</script>`;
    const occ = extractEventJsonLdOccurrences(html);
    expect(occ).toHaveLength(2);
  });

  it('skips unrelated JSON-LD blocks (e.g. BreadcrumbList) and picks the Event block', () => {
    const html = `
      <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type="application/ld+json">{"@type":"Event","name":"Real Event","startDate":"2026-07-04T19:00"}</script>
    `;
    const occ = extractEventJsonLdOccurrences(html);
    expect(occ).toHaveLength(1);
    expect(occ[0].name).toBe('Real Event');
  });

  it('returns [] when there is no matching block or malformed JSON', () => {
    expect(extractEventJsonLdOccurrences('')).toEqual([]);
    expect(extractEventJsonLdOccurrences('<html></html>')).toEqual([]);
    expect(extractEventJsonLdOccurrences('<script type="application/ld+json">{not json</script>')).toEqual([]);
  });
});

// Shape measured on 16 of the 80 Guidle detail pages of crawl run 37198131294
// (2026-10-04): the organizer text is pasted verbatim into the JSON-LD string,
// raw line breaks included, so the block is not valid JSON. Anonymized.
const RAW_NEWLINE_JSON_LD = [
  '{',
  '  "@context": "http://schema.org/",',
  '  "@type": "Event",',
  '  "name": "Konzert am See",',
  '  "description": "Türöffnung: 20:00 Uhr',
  'Konzertbeginn: 20:45 Uhr',
  '\tEintritt: CHF 25.00",',
  '  "startDate": "2026-11-06T20:45",',
  '  "location": {"name": "Saal", "address": {"addressLocality": "Musterdorf"}}',
  '}',
].join('\n');

describe('Guidle JSON-LD with raw control characters inside strings', () => {
  it('reads the Event occurrence instead of dropping the block as malformed', () => {
    const occ = extractEventJsonLdOccurrences(`<script type="application/ld+json">${RAW_NEWLINE_JSON_LD}</script>`);
    expect(occ).toHaveLength(1);
    expect(occ[0].name).toBe('Konzert am See');
    expect(occ[0].startDate).toBe('2026-11-06T20:45');
    expect(occ[0].description).toBe('Türöffnung: 20:00 Uhr\nKonzertbeginn: 20:45 Uhr\n\tEintritt: CHF 25.00');
  });

  it('maps the detail page instead of reporting it as parser drift', () => {
    const mapped = mapDetailPageToLocaleData(buildDetailHtml({ jsonLd: RAW_NEWLINE_JSON_LD }), 'de');
    expect(mapped?.title).toBe('Konzert am See');
    expect(mapped?.startDate).toBe('2026-11-06');
    expect(mapped?.startTime).toBe('20:45');
    expect(mapped?.description).toBe('Türöffnung: 20:00 Uhr Konzertbeginn: 20:45 Uhr Eintritt: CHF 25.00');
  });
});

// Shape measured on the film catalog entries (`kino-nach-film/ohne-ortsangabe/…`)
// sampled 2026-10-04: no JSON-LD at all, and the microdata block declares an
// EMPTY startDate. The source publishes no schedule, so there is nothing to
// parse. Anonymized.
const UNDATED_LISTING_HTML = `<!doctype html><html><head><title>Film - Schweiz (ohne Ortsangabe) - Guidle</title></head><body>
  <div itemscope itemtype="http://schema.org/Event">
    <span itemprop="eventType">Kinofilm</span>
    <meta itemprop="startDate" content="" />
    <span itemprop="location">Schweiz (ohne Ortsangabe)</span>
  </div></body></html>`;
const UNDATED_FILM_CATALOG_PATH = '/kino-nach-film/ohne-ortsangabe/film_A123456';

describe('isUndatedGuidleListing', () => {
  it('recognizes a page that declares an empty startDate and carries no Event JSON-LD', () => {
    expect(isUndatedGuidleListing(UNDATED_LISTING_HTML, UNDATED_FILM_CATALOG_PATH)).toBe(true);
  });

  it.each([
    '/kino-nach-film/ohne-ortsangabe/film_A123456',
    '/cinema-by-movie/ohne-ortsangabe/film_A123456',
    '/cinema-by-movie/sans-indication-de-lieu/film_A123456',
    '/kino-nach-film/senza-posizione/film_A123456',
  ])('recognizes every verified segment of the film catalog (%s)', (pathSuffix) => {
    expect(isUndatedGuidleListing(UNDATED_LISTING_HTML, pathSuffix)).toBe(true);
  });

  it('does not excuse other film or location-less sections that were not verified', () => {
    expect(isUndatedGuidleListing(UNDATED_LISTING_HTML, '/kino/filmarchiv/film_A123456')).toBe(false);
    expect(isUndatedGuidleListing(UNDATED_LISTING_HTML, '/veranstaltungen/ohne-ortsangabe/event_A123456')).toBe(false);
  });

  it('requires the positive film-catalog discriminator before excusing malformed markup', () => {
    const brokenNonCatalogEvent = '<script type="application/ld+json">{malformed Event</script>'
      + '<meta itemprop="startDate" content="">';
    expect(isUndatedGuidleListing(brokenNonCatalogEvent, '/veranstaltungen/zug/event_A123456')).toBe(false);
    expect(isUndatedGuidleListing(UNDATED_LISTING_HTML)).toBe(false);
  });

  it('does not excuse a page whose startDate is filled: that is drift', () => {
    expect(isUndatedGuidleListing(
      UNDATED_LISTING_HTML.replace('content=""', 'content="2026-11-06T20:45"'),
      UNDATED_FILM_CATALOG_PATH,
    )).toBe(false);
  });

  it('does not excuse a page without any startDate declaration: that is drift', () => {
    expect(isUndatedGuidleListing('<html><body><span itemprop="eventType">Festival</span></body></html>')).toBe(false);
    expect(isUndatedGuidleListing('')).toBe(false);
  });

  it('does not excuse a page that has a readable Event JSON-LD block', () => {
    expect(isUndatedGuidleListing(buildDetailHtml(), UNDATED_FILM_CATALOG_PATH)).toBe(false);
  });
});

describe('classifyUnmappedGuidleDetail', () => {
  it('calls an event gone only when every locale answered 404 or 410', () => {
    expect(classifyUnmappedGuidleDetail([410, 410, 410, 410])).toBe('gone');
    expect(classifyUnmappedGuidleDetail([404, 410, 404, 404])).toBe('gone');
  });

  it('treats HTML that did not parse as drift', () => {
    expect(classifyUnmappedGuidleDetail([200, 410, 410, 410])).toBe('drift');
    expect(classifyUnmappedGuidleDetail([200, 200, 200, 200])).toBe('drift');
  });

  it('calls a detail undated only when every locale that answered declared no schedule', () => {
    expect(classifyUnmappedGuidleDetail([200, 200, 200, 200], [true, true, true, true])).toBe('undated');
    expect(classifyUnmappedGuidleDetail([200, 410, 200, 410], [true, false, true, false])).toBe('undated');
    expect(classifyUnmappedGuidleDetail([200, 200, 200, 200], [true, false, true, true])).toBe('drift');
  });

  it('lets any transient or non-definitive locale failure override undated', () => {
    expect(classifyUnmappedGuidleDetail([200, 503], [true, false])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([200, 429], [true, false])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([200, 0], [true, false])).toBe('unreachable');
  });

  it('keeps a missing answer (network, WAF, 5xx, rate limit) as an unreachable failure, not a disappearance', () => {
    expect(classifyUnmappedGuidleDetail([0, 0, 0, 0])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([410, 410, 0, 410])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([403, 403, 403, 403])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([503, 410, 410, 410])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([429, 429, 429, 429])).toBe('unreachable');
    expect(classifyUnmappedGuidleDetail([])).toBe('unreachable');
  });
});

describe('guidleEmptyRunOutcome', () => {
  it('treats all 2xx empty-body detail responses as parser drift, not transient', () => {
    const responses = [200, 200, 200, 200].map(status => ({ status, text: '' }));
    const successfulDetailFetches = responses.filter(({ status }) => status >= 200 && status < 300).length;
    expect(guidleEmptyRunOutcome({ mappedCount: 0, goneCount: 0, undatedCount: 0, successfulDetailFetches }))
      .toBe('drift');
    expect(guidleEmptyRunOutcome({ mappedCount: 0, goneCount: 0, undatedCount: 0, successfulDetailFetches: 0 }))
      .toBe('transient');
  });
});

describe('guidleDetailFailureAccounting', () => {
  const outcomes = (counts: Record<string, number>) => Object.entries(counts).flatMap(([kind, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `guidle:${kind}${i}`, kind })));
  const policy = (acc: ReturnType<typeof guidleDetailFailureAccounting>) => applyDetailFailureReuse({
    freshRows: [],
    failedIdentities: acc.detailFailureIds,
    attemptedCount: acc.detailAttemptCount,
    previousRows: [],
    identityOf: (event: { id?: string }) => event?.id,
  });

  it('keeps a confirmed disappearance out of the parse-failure ratio, numerator and denominator', () => {
    const run = outcomes({ mapped: 77, drift: 1, gone: 2 });
    const acc = guidleDetailFailureAccounting(run);
    const gone = run.filter(o => o.kind === 'gone').map(o => o.id);
    const drift = run.filter(o => o.kind === 'drift').map(o => o.id);
    expect(acc.goneIds).toEqual(gone);
    expect(acc.detailFailureIds).toEqual(drift);
    expect(acc.detailAttemptCount).toBe(run.length - gone.length);
    expect(policy(acc).canPublish).toBe(true);
  });

  it('keeps undated source listings out of the ratio without reporting them as disappeared', () => {
    const run = outcomes({ mapped: 20, undated: 35, drift: 1, gone: 4 });
    const acc = guidleDetailFailureAccounting(run);
    const undated = run.filter(o => o.kind === 'undated').map(o => o.id);
    expect(acc.undatedIds).toEqual(undated);
    expect(acc.goneIds.some(id => undated.includes(id))).toBe(false);
    expect(acc.detailFailureIds).toEqual(run.filter(o => o.kind === 'drift').map(o => o.id));
    expect(acc.detailAttemptCount).toBe(run.length - undated.length - acc.goneIds.length);
    expect(policy(acc).canPublish).toBe(true);
  });

  it('still fails closed on real parser drift above the threshold', () => {
    const acc = guidleDetailFailureAccounting(outcomes({ mapped: 61, drift: 17, gone: 2 }));
    expect(policy(acc).withinGrace).toBe(false);
    expect(policy(acc).canPublish).toBe(false);
  });

  it('still fails closed when the source is unreachable instead of calling it gone', () => {
    const run = outcomes({ unreachable: 80 });
    const acc = guidleDetailFailureAccounting(run);
    expect(acc.goneIds).toEqual([]);
    expect(acc.detailFailureIds).toEqual(run.map(o => o.id));
    expect(policy(acc).canPublish).toBe(false);
  });

  it('a gone event does not dilute the ratio: the denominator shrinks with it', () => {
    // 12 drift over 70 parseable details is 17%: over the threshold even if
    // 10 confirmed disappearances would have brought it to 15% of 80.
    const acc = guidleDetailFailureAccounting(outcomes({ mapped: 58, drift: 12, gone: 10 }));
    expect(policy(acc).canPublish).toBe(false);
  });
});

describe('summarizeOccurrences', () => {
  it('returns null for an empty list', () => {
    expect(summarizeOccurrences([])).toBeNull();
  });

  it('derives startDate/startTime from a single occurrence, recurring:false', () => {
    const info = summarizeOccurrences([{ startDate: '2026-07-04T19:30', endDate: '2026-07-04T22:00' }]);
    expect(info).toEqual({ startDate: '2026-07-04', startTime: '19:30', endDate: '2026-07-04', recurring: false });
  });

  it('spans earliest→latest and flags recurring:true for multiple occurrences', () => {
    const info = summarizeOccurrences([
      { startDate: '2026-07-11T09:50' },
      { startDate: '2026-07-04T09:50' },
      { startDate: '2026-07-18T09:50' },
    ]);
    expect(info?.startDate).toBe('2026-07-04');
    expect(info?.endDate).toBe('2026-07-18');
    expect(info?.recurring).toBe(true);
  });
});

describe('extractAddress', () => {
  it('reads street + postalCode from a PostalAddress', () => {
    expect(extractAddress({ streetAddress: 'Piazza Grande 1', postalCode: '6600' })).toEqual({
      street: 'Piazza Grande 1',
      postalCode: '6600',
    });
  });

  it('returns undefined when absent/empty', () => {
    expect(extractAddress(undefined)).toBeUndefined();
    expect(extractAddress({})).toBeUndefined();
  });
});

describe('parsePriceText', () => {
  it('takes the cheapest numeric amount found', () => {
    expect(parsePriceText('CHF 10.00 pro Person, Kinder CHF 5.00')).toEqual({ amount: 5, currency: 'CHF', isFree: false });
    expect(parsePriceText('CHF10')).toEqual({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('10CHF')).toEqual({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('CHF 20 (EUR 22)')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('20 euro')).toEqual({ amount: 20, currency: 'EUR', isFree: false });
    expect(parsePriceText('CHF 20, 20:00')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Free for children under 12, adults CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Bambini gratuiti, adulti CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Admission for 2 adults CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Admission: 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Admission: 2 adults CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Ingresso: 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('children under 12 are free, adults CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Parcheggio gratis, ingresso CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Bambini gratis, ingresso su richiesta')).toEqual({ amount: null, currency: 'CHF', isFree: false });
    expect(parsePriceText('20 €')).toEqual({ amount: 20, currency: 'EUR', isFree: false });
    expect(parsePriceText('20 Fr.')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('CHF 1000.00')).toEqual({ amount: 1000, currency: 'CHF', isFree: false });
    expect(parsePriceText('CHF 100000')).toEqual({ amount: 100000, currency: 'CHF', isFree: false });
    expect(parsePriceText('10–20 CHF')).toEqual({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('Admission free, parking CHF 5')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Parking free. Admission CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Price 20, call +41 91 123 45 67')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Prezzi: 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Tariffe: 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Entry free, adults CHF 20')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Price: 41 91 123 45 67').amount).toBeNull();
    expect(parsePriceText('ticketEUR20').amount).toBeNull();
    expect(parsePriceText('2024CHF').amount).toBeNull();
    expect(parsePriceText('Price: call +41 91 123 45 67 CHF')).toEqual({ amount: null, currency: 'CHF', isFree: false });
    expect(parsePriceText('Parking: CHF 5, Admission free')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('10.– CHF')).toEqual({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('Admission free, call +41 91 123 45 67')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Gratuit pour tous')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Gratis per tutti')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Free for all')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Price: 10 CHF/person')).toEqual({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('Freier Eintritt')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('entrées gratuites')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Access free')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Accesso gratuito')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('accès gratuit')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Gratuits pour tous')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Gratuites pour tous')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Accès gratuits')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
  });

  it('recognizes free-language keywords when there is no number', () => {
    expect(parsePriceText('Eintritt frei')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsePriceText('Ingresso libero')).toEqual({ amount: 0, currency: 'CHF', isFree: true });
  });

  it('falls back to amount:null when unparseable', () => {
    expect(parsePriceText('Su richiesta')).toEqual({ amount: null, currency: 'CHF', isFree: false });
  });

  it('returns undefined for empty input', () => {
    expect(parsePriceText('')).toBeUndefined();
    expect(parsePriceText(undefined)).toBeUndefined();
  });

  it.each([
    'gratis', 'gratuito', 'gratuit', 'gratuite', 'kostenlos', 'Eintritt frei', 'free entry',
    'free admission', 'ingresso libero', 'ingresso gratuito', 'entrée libre', 'entrée gratuite',
  ])('records localized free-access evidence: %s', (label) => {
    const parsed = parsePriceText(label);
    expect(parsed).toMatchObject({ amount: 0, currency: 'CHF', isFree: true });
    expect(parsed.evidence).toBe('label-free');
  });

  it('accepts explicit zero tariffs and ignores dates, phones and identifiers', () => {
    expect(parsePriceText('CHF 0')).toMatchObject({ amount: 0, isFree: true });
    expect(parsePriceText('0.–')).toMatchObject({ amount: 0, isFree: true });
    expect(parsePriceText("CHF 1'000")).toMatchObject({ amount: 1000, isFree: false });
    expect(parsePriceText('CHF 1.234,50')).toMatchObject({ amount: 1234.5, isFree: false });
    expect(parsePriceText('20')).toMatchObject({ amount: 20, isFree: false });
    expect(parsePriceText('CHF10')).toMatchObject({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('10CHF')).toMatchObject({ amount: 10, currency: 'CHF', isFree: false });
    expect(parsePriceText('CHF 20 (EUR 22)')).toMatchObject({ amount: 20, currency: 'CHF', isFree: false });
    expect(parsePriceText('Ingresso 20 franchi, Bambini gratis')).toMatchObject({ amount: 20, isFree: false });
    expect(parsePriceText('children are free, adults 20')).toMatchObject({ amount: 20, isFree: false });
    expect(parsePriceText('Kids 0–5 free, adults CHF 20')).toMatchObject({ amount: 20, isFree: false });
    expect(parsePriceText('Bambini gratuiti, adulti CHF 20')).toMatchObject({ amount: 20, isFree: false });
    expect(parsePriceText('2026-07-04')).toMatchObject({ amount: null, isFree: false });
    expect(parsePriceText('+41 91 555 12 34')).toMatchObject({ amount: null, isFree: false });
    expect(parsePriceText('ID 123456')).toMatchObject({ amount: null, isFree: false });
  });
});

// Provenance stamps (owner decision 2026-10-04): the accordion is tariff text,
// the JSON-LD Offer is Guidle's structured field.
const PRICE_ACCORDION = { priceSource: 'guidle', priceField: 'price-accordion' };
const OFFER_PRICE = { priceSource: 'guidle', priceField: 'offers.price' };

function buildDetailHtml({
  locale = 'de',
  categoryLabel = 'Kategorie',
  categoryValue = 'Konzert',
  priceLabel = 'Preis',
  priceValue = 'CHF 20.00 pro Person',
  geoPosition = '47.1661118;8.5151648',
  geoRegion = 'CH-ZG',
  jsonLd = '{"@type":"Event","name":"Zytturm Konzert","description":"Ein tolles Konzert.","startDate":"2026-07-04T19:00","location":{"name":"Zytturm","address":{"streetAddress":"Kolinplatz 1","postalCode":"6300","addressLocality":"Zug"}},"image":"https://www.guidle.com/imagekit/abc.jpg"}',
} = {}) {
  return `<!doctype html><html lang="${locale}"><head>
    <meta name="geo.position" content="${geoPosition}" />
    <meta name="geo.region" content="${geoRegion}" />
    <script type="application/ld+json">${jsonLd}</script>
  </head><body>
    <div class="accordion-wrap"><h3>${categoryLabel}</h3><div class="accordion"><ul><li>${categoryValue}</li></ul></div></div>
    <div class="accordion-wrap"><h3>${priceLabel}</h3><div class="accordion">${priceValue}</div></div>
  </body></html>`;
}

describe('extractCategory / extractPrice / extractGeoAndCanton (DOM accordion + meta scraping)', () => {
  it('reads category and price from locale-labelled accordion blocks', () => {
    const doc = new JSDOM(buildDetailHtml()).window.document;
    expect(extractCategory(doc, 'de')).toBe('Konzert');
    expect(extractPrice(doc, 'de')).toEqual({ amount: 20, currency: 'CHF', isFree: false, ...PRICE_ACCORDION });
  });

  it('matches the it/en/fr accordion label translations', () => {
    const it = new JSDOM(buildDetailHtml({ locale: 'it', categoryLabel: 'Categoria', categoryValue: 'Concerto', priceLabel: 'Prezzo' })).window.document;
    expect(extractCategory(it, 'it')).toBe('Concerto');
    expect(extractPrice(it, 'it')).toEqual({ amount: 20, currency: 'CHF', isFree: false, ...PRICE_ACCORDION });

    const fr = new JSDOM(buildDetailHtml({ locale: 'fr', categoryLabel: 'Catégorie', priceLabel: 'Prix' })).window.document;
    expect(extractCategory(fr, 'fr')).toBe('Konzert');

    const en = new JSDOM(buildDetailHtml({ locale: 'en', categoryLabel: 'Category', priceLabel: 'Price' })).window.document;
    expect(extractCategory(en, 'en')).toBe('Konzert');
  });

  it('returns undefined when the expected accordion label is missing', () => {
    const doc = new JSDOM(buildDetailHtml({ categoryLabel: 'Something Else' })).window.document;
    expect(extractCategory(doc, 'de')).toBeUndefined();
  });

  it('reads geo + canton from meta tags', () => {
    const doc = new JSDOM(buildDetailHtml()).window.document;
    expect(extractGeoAndCanton(doc)).toEqual({ geo: { lat: 47.1661118, lng: 8.5151648 }, canton: 'ZG' });
  });

  it('returns undefined geo/canton when meta tags are absent', () => {
    const doc = new JSDOM('<html><head></head><body></body></html>').window.document;
    expect(extractGeoAndCanton(doc)).toEqual({ geo: undefined, canton: undefined });
  });
});

describe('mapDetailPageToLocaleData', () => {
  it('maps a full detail page into a flat locale-data record', () => {
    const mapped = mapDetailPageToLocaleData(buildDetailHtml(), 'de');
    expect(mapped).toEqual({
      title: 'Zytturm Konzert',
      description: 'Ein tolles Konzert.',
      startDate: '2026-07-04',
      startTime: '19:00',
      endDate: '2026-07-04',
      recurring: false,
      venue: 'Zytturm',
      address: { street: 'Kolinplatz 1', postalCode: '6300' },
      addressLocality: 'Zug',
      imageSourceUrl: 'https://www.guidle.com/imagekit/abc.jpg',
      category: 'Konzert',
      price: { amount: 20, currency: 'CHF', isFree: false, ...PRICE_ACCORDION },
      geo: { lat: 47.1661118, lng: 8.5151648 },
      canton: 'ZG',
    });
  });

  it('keeps named organizer/performer entities and image arrays from source JSON-LD', () => {
    const mapped = mapDetailPageToLocaleData(
      buildDetailHtml({
        jsonLd: JSON.stringify({
          '@type': 'Event',
          name: 'Evento con metadati',
          description: 'Un evento di prova con metadati dalla fonte.',
          startDate: '2026-07-04T19:00',
          location: { name: 'Zytturm', address: { addressLocality: 'Zug' } },
          image: [{ url: '/imagekit/evento.jpg' }],
          organizer: { '@type': 'Organization', name: 'Guidle Veranstalter', url: '/organizer' },
          performer: [{ '@type': 'Person', name: 'Artista Guidle' }],
        }),
      }),
      'de',
    );
    expect(mapped?.imageSourceUrl).toBe('https://www.guidle.com/imagekit/evento.jpg');
    expect(mapped?.organizer).toEqual({
      '@type': 'Organization',
      name: 'Guidle Veranstalter',
      url: 'https://www.guidle.com/organizer',
    });
    expect(mapped?.performer).toEqual([{ '@type': 'Person', name: 'Artista Guidle' }]);
  });

  it('fills title performers and preserves source Offer metadata', () => {
    const mapped = mapDetailPageToLocaleData(
      buildDetailHtml({
        priceValue: 'CHF 15.00',
        jsonLd: JSON.stringify({
          '@type': 'Event',
          name: 'Musik und Tanz mit „Ghörsch“',
          description: 'Ein Konzertabend mit einem benannten Act.',
          startDate: '2026-07-04T19:00',
          location: { name: 'Zytturm', address: { addressLocality: 'Zug' } },
          offers: {
            price: '15',
            priceCurrency: 'CHF',
            availability: 'https://schema.org/InStock',
            validFrom: '2026-06-01T09:00:00+02:00',
            url: '/tickets/ghoersch',
          },
        }),
      }),
      'de',
      'https://www.guidle.com/de/veranstaltungen/zug/musik-und-tanz_GHOERSCH',
    );
    expect(mapped?.performer).toEqual({ name: 'Ghörsch' });
    expect(mapped?.price).toEqual({
      amount: 15,
      currency: 'CHF',
      isFree: false,
      availability: 'https://schema.org/InStock',
      validFrom: '2026-06-01T09:00:00+02:00',
      url: 'https://www.guidle.com/tickets/ghoersch',
      ...OFFER_PRICE,
    });
  });

  it('fills source people from the full itemprop description when JSON-LD is abbreviated', () => {
    const html = buildDetailHtml({
      jsonLd: JSON.stringify({
        '@type': 'Event',
        name: 'Autechre',
        description: 'Chaotisch, roh, faszinierend.',
        startDate: '2026-09-25T20:00',
        location: { name: 'Rote Fabrik', address: { addressLocality: 'Zurigo' } },
      }),
    }).replace('</body>', '<p itemprop="description">Präsentiert von Noise Reduction &amp; Musikbüro Rote Fabrik<br>Mitwirkende und Zusatzinformationen:<br>Autechre</p></body>');
    const mapped = mapDetailPageToLocaleData(html, 'de', 'https://www.guidle.com/de/veranstaltungen/zug/autechre_AU123');
    expect(mapped?.organizer).toEqual({
      '@type': 'Organization',
      name: 'Noise Reduction & Musikbüro Rote Fabrik',
      url: 'https://www.guidle.com/de/veranstaltungen/zug/autechre_AU123',
    });
    expect(mapped?.performer).toEqual({ name: 'Autechre' });
  });

  it('returns null when the page has no usable Event JSON-LD', () => {
    expect(mapDetailPageToLocaleData('<html></html>', 'de')).toBeNull();
    expect(mapDetailPageToLocaleData('', 'de')).toBeNull();
  });

  it('returns null when the JSON-LD event has no name', () => {
    const html = buildDetailHtml({ jsonLd: '{"@type":"Event","startDate":"2026-07-04T19:00"}' });
    expect(mapDetailPageToLocaleData(html, 'de')).toBeNull();
  });
});

describe('mapGuidleEvent', () => {
  const deData = {
    title: 'Zytturm Konzert',
    description: 'Ein tolles Konzert.',
    startDate: '2026-07-04',
    startTime: '19:00',
    endDate: '2026-07-04',
    recurring: false,
    venue: 'Zytturm',
    address: { street: 'Kolinplatz 1', postalCode: '6300' },
    addressLocality: 'Zug',
    imageSourceUrl: 'https://www.guidle.com/imagekit/abc.jpg',
    category: 'Konzert',
    price: { amount: 20, currency: 'CHF', isFree: false },
    geo: { lat: 47.1661118, lng: 8.5151648 },
    canton: 'ZG',
    url: 'https://www.guidle.com/de/veranstaltungen/zug/stadtfuehrung_AZ3RYEB',
  };
  const itData = { ...deData, title: 'Concerto Zytturm', description: 'Un bel concerto.', url: 'https://www.guidle.com/it/eventi/zugo/stadtfuehrung_AZ3RYEB' };

  it('returns null when every locale is unusable (event fully gone)', () => {
    expect(mapGuidleEvent('AZ3RYEB', { it: null, en: null, de: null, fr: null })).toBeNull();
  });

  it('maps a single-locale result to a SiteEvent-shaped record', () => {
    const mapped = mapGuidleEvent('AZ3RYEB', { it: null, en: null, de: deData, fr: null });
    expect(mapped).not.toBeNull();
    const { event, imageSourceUrl, addressLocality, cantonHint } = mapped as never as {
      event: Record<string, unknown>;
      imageSourceUrl: string;
      addressLocality: string;
      cantonHint: string;
    };
    expect(event.id).toBe('guidle:AZ3RYEB');
    expect(event.title).toBe('Zytturm Konzert');
    expect(event.titleByLocale).toEqual({ de: 'Zytturm Konzert' });
    expect(event.descriptionByLocale).toEqual({ de: 'Ein tolles Konzert.' });
    expect(event.startDate).toBe('2026-07-04');
    expect(event.category).toBe('Konzert');
    expect(event.venue).toBe('Zytturm');
    expect(event.sourceKey).toBe('guidle');
    expect(event.sourceName).toBe('Guidle');
    expect(event.url).toBe('https://www.guidle.com/de/veranstaltungen/zug/stadtfuehrung_AZ3RYEB');
    expect(event.canton).toBe('');
    expect(event.organizer).toEqual({
      '@type': 'Organization',
      name: 'Guidle',
      url: 'https://www.guidle.com/',
    });
    expect(event.performer).toEqual({ '@type': 'Organization', name: 'Zytturm' });
    expect(imageSourceUrl).toBe('https://www.guidle.com/imagekit/abc.jpg');
    expect(addressLocality).toBe('Zug');
    expect(cantonHint).toBe('ZG');
  });

  it('prefers it as canonical/primary (it→en→de→fr order) and merges titleByLocale/descriptionByLocale', () => {
    const mapped = mapGuidleEvent('AZ3RYEB', { it: itData, en: null, de: deData, fr: null });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.title).toBe('Concerto Zytturm');
    expect(event.titleByLocale).toEqual({ it: 'Concerto Zytturm', de: 'Zytturm Konzert' });
    expect(event.descriptionByLocale).toEqual({ it: 'Un bel concerto.', de: 'Ein tolles Konzert.' });
    expect(event.url).toBe('https://www.guidle.com/it/eventi/zugo/stadtfuehrung_AZ3RYEB');
  });

  it('fills optional source metadata from a later locale when the primary omits it', () => {
    const mapped = mapGuidleEvent(
      'AZ3RYEB',
      {
        it: { ...itData, imageSourceUrl: undefined },
        en: {
          ...deData,
          imageSourceUrl: 'https://www.guidle.com/imagekit/en-abc.jpg',
          organizer: { '@type': 'Organization', name: 'Guidle Veranstalter' },
          performer: { '@type': 'Person', name: 'Artista Guidle' },
        },
        de: null,
        fr: null,
      },
    );
    const event = mapped?.event as never as Record<string, unknown>;
    expect((mapped as never as { imageSourceUrl: string }).imageSourceUrl).toBe(
      'https://www.guidle.com/imagekit/en-abc.jpg',
    );
    expect(event.organizer).toEqual({
      '@type': 'Organization',
      name: 'Guidle Veranstalter',
      url: 'https://www.guidle.com/it/eventi/zugo/stadtfuehrung_AZ3RYEB',
    });
    expect(event.performer).toEqual({ '@type': 'Person', name: 'Artista Guidle' });
  });

  it('defaults category to "Event" when no accordion category was found', () => {
    const mapped = mapGuidleEvent('AZ3RYEB', { it: null, en: null, de: { ...deData, category: undefined }, fr: null });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.category).toBe('Event');
  });
});
