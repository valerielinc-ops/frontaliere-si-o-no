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
} from '../scripts/crawl-guidle-events.mjs';

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
});

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
    expect(extractPrice(doc, 'de')).toEqual({ amount: 20, currency: 'CHF', isFree: false });
  });

  it('matches the it/en/fr accordion label translations', () => {
    const it = new JSDOM(buildDetailHtml({ locale: 'it', categoryLabel: 'Categoria', categoryValue: 'Concerto', priceLabel: 'Prezzo' })).window.document;
    expect(extractCategory(it, 'it')).toBe('Concerto');
    expect(extractPrice(it, 'it')).toEqual({ amount: 20, currency: 'CHF', isFree: false });

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
      price: { amount: 20, currency: 'CHF', isFree: false },
      geo: { lat: 47.1661118, lng: 8.5151648 },
      canton: 'ZG',
    });
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

  it('defaults category to "Event" when no accordion category was found', () => {
    const mapped = mapGuidleEvent('AZ3RYEB', { it: null, en: null, de: { ...deData, category: undefined }, fr: null });
    const event = mapped?.event as never as Record<string, unknown>;
    expect(event.category).toBe('Event');
  });
});
