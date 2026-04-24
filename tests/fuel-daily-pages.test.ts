/**
 * Tests for fuel-daily SEO pages (F6).
 *
 * Covers:
 *  - Slug tables + path builders for all 4 locales × 2 fuels × (regional + 5 zones)
 *  - Route enumeration (FUEL_DAILY_ROUTES contains 48 unique paths)
 *  - Page generation: ≥250 words per page, JSON-LD present & parseable,
 *    canonical self-referent, FAQ block, trend table
 *  - Archive generation only for past months
 *  - isFuelDailyPath / isFuelMonthArchivePath router helpers
 */

import { describe, expect, it } from 'vitest';
import {
  FUEL_DAILY_LOCALES,
  FUEL_DAILY_ROUTES,
  FUEL_SECTION_SLUG,
  FUEL_TYPES,
  FUEL_ZONES,
  buildFuelArchivePath,
  buildFuelTodayPath,
  isFuelDailyPath,
  isFuelMonthArchivePath,
  listFuelTodayPaths,
} from '../build-plugins/fuelDailyData';
import {
  generateFuelArchivePages,
  generateFuelDailyPages,
} from '../build-plugins/fuelDailyPagesPlugin';

// Minimal dataset sufficient for the renderer (nearby Swiss stations in each
// target zone + enough copy seeds to clear the 250-word gate).
// Diesel fixtures: all stations carry a real `dieselPriceChf` (TCS Firestore
// feed exposes per-station DIESEL) — this exercises the primary code path.
// `c9` intentionally omits diesel to exercise the SP95+offset fallback.
const DATASET = {
  generatedAt: '2026-04-20T06:00:00.000Z',
  municipalities: [
    {
      municipality: 'Test',
      province: 'CO',
      swiss: {
        nearbyStations: [
          { id: 'c1', name: 'Piccadilly Chiasso', brand: 'PICCADILLY', address: 'Via San Gottardo 12, 6830 Chiasso', sp95PriceChf: 1.78, dieselPriceChf: 1.95, dieselSource: 'api' as const },
          { id: 'c2', name: 'Pemoil Chiasso', brand: 'PEMOIL', address: 'Corso San Gottardo 100, 6830 Chiasso', sp95PriceChf: 1.81, dieselPriceChf: 1.99, dieselSource: 'api' as const },
          { id: 'c3', name: 'Station Allo Svincolo', brand: 'UNDEFINED', address: 'Via Francesco Borromini 6, 6850 Mendrisio', sp95PriceChf: 1.80, dieselPriceChf: 1.97, dieselSource: 'api' as const },
          { id: 'c4', name: 'SOCAR Mendrisio', brand: 'PICCADILLY', address: 'Via Franco Zorzi 4, 6850 Mendrisio', sp95PriceChf: 1.82, dieselPriceChf: 2.01, dieselSource: 'api' as const },
          { id: 'c5', name: 'Migrol Lugano', brand: 'MIGROL', address: 'Via Pioda 2, 6900 Lugano', sp95PriceChf: 1.84, dieselPriceChf: 2.03, dieselSource: 'api' as const },
          { id: 'c6', name: 'Coop Lugano', brand: 'COOP', address: 'Via Zurigo 15, 6900 Lugano', sp95PriceChf: 1.86, dieselPriceChf: 2.06, dieselSource: 'api' as const },
          { id: 'c7', name: 'AVIA Bellinzona', brand: 'AVIA', address: 'Viale Portone 3, 6500 Bellinzona', sp95PriceChf: 1.83, dieselPriceChf: 2.02, dieselSource: 'api' as const },
          { id: 'c8', name: 'Shell Bellinzona', brand: 'SHELL', address: 'Via San Gottardo 20, 6500 Bellinzona', sp95PriceChf: 1.85, dieselPriceChf: 2.04, dieselSource: 'api' as const },
          // c9: no dieselPriceChf — exercises SP95+offset fallback
          { id: 'c9', name: 'Tamoil Locarno', brand: 'TAMOIL', address: 'Viale Balli 4, 6600 Locarno', sp95PriceChf: 1.87 },
          { id: 'c10', name: 'BP Locarno', brand: 'BP', address: 'Via San Gottardo 80, 6600 Locarno', sp95PriceChf: 1.89, dieselPriceChf: 2.08, dieselSource: 'api' as const },
        ],
      },
    },
  ],
};

describe('fuelDailyData — slug tables', () => {
  it('exposes exactly 4 locales and 2 fuel types', () => {
    expect(FUEL_DAILY_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
    expect(FUEL_TYPES).toEqual(['diesel', 'benzina']);
  });

  it('exposes exactly 5 zones', () => {
    expect(FUEL_ZONES).toEqual(['chiasso', 'mendrisio', 'lugano', 'bellinzona', 'locarno']);
  });

  it('uses expected section slugs per locale × fuel', () => {
    expect(FUEL_SECTION_SLUG.it.diesel).toBe('prezzi-diesel');
    expect(FUEL_SECTION_SLUG.it.benzina).toBe('prezzi-benzina');
    expect(FUEL_SECTION_SLUG.en.diesel).toBe('diesel-price-switzerland');
    expect(FUEL_SECTION_SLUG.en.benzina).toBe('gasoline-price-switzerland');
    expect(FUEL_SECTION_SLUG.de.diesel).toBe('dieselpreis-schweiz');
    expect(FUEL_SECTION_SLUG.de.benzina).toBe('benzinpreis-schweiz');
    expect(FUEL_SECTION_SLUG.fr.diesel).toBe('prix-gasoil-suisse');
    expect(FUEL_SECTION_SLUG.fr.benzina).toBe('prix-essence-suisse');
  });
});

describe('fuelDailyData — path builders', () => {
  it('builds IT regional path', () => {
    expect(buildFuelTodayPath('it', 'diesel')).toBe('/prezzi-diesel/oggi/');
    expect(buildFuelTodayPath('it', 'benzina')).toBe('/prezzi-benzina/oggi/');
  });

  it('builds IT zone paths', () => {
    expect(buildFuelTodayPath('it', 'diesel', 'chiasso')).toBe('/prezzi-diesel/chiasso/oggi/');
    expect(buildFuelTodayPath('it', 'diesel', 'mendrisio')).toBe('/prezzi-diesel/mendrisio/oggi/');
  });

  it('builds EN / DE / FR regional paths', () => {
    expect(buildFuelTodayPath('en', 'diesel')).toBe('/en/diesel-price-switzerland/today/');
    expect(buildFuelTodayPath('de', 'diesel')).toBe('/de/dieselpreis-schweiz/heute/');
    expect(buildFuelTodayPath('fr', 'diesel')).toBe('/fr/prix-gasoil-suisse/aujourd-hui/');
  });

  it('builds EN / DE / FR zone paths', () => {
    expect(buildFuelTodayPath('en', 'benzina', 'lugano')).toBe('/en/gasoline-price-switzerland/lugano/today/');
    expect(buildFuelTodayPath('de', 'benzina', 'bellinzona')).toBe('/de/benzinpreis-schweiz/bellinzona/heute/');
    expect(buildFuelTodayPath('fr', 'benzina', 'locarno')).toBe('/fr/prix-essence-suisse/locarno/aujourd-hui/');
  });

  it('builds IT archive paths for a past month', () => {
    expect(buildFuelArchivePath('it', 'diesel', 'chiasso', '2026-03')).toBe('/prezzi-diesel/chiasso/2026-03/');
  });
});

describe('fuelDailyData — route enumeration', () => {
  it('generates exactly 48 "today" paths (4 locales × 2 fuels × (1 regional + 5 zones))', () => {
    const paths = listFuelTodayPaths();
    expect(paths).toHaveLength(48);
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(48);
    for (const p of paths) expect(p.path.endsWith('/')).toBe(true);
  });

  it('FUEL_DAILY_ROUTES mirrors listFuelTodayPaths()', () => {
    expect(FUEL_DAILY_ROUTES).toHaveLength(48);
  });

  it('isFuelDailyPath recognises every canonical path', () => {
    for (const path of FUEL_DAILY_ROUTES) {
      expect(isFuelDailyPath(path)).toBe(true);
    }
  });

  it('isFuelDailyPath tolerates missing trailing slash', () => {
    expect(isFuelDailyPath('/prezzi-diesel/oggi')).toBe(true);
  });

  it('isFuelDailyPath rejects unrelated paths', () => {
    expect(isFuelDailyPath('/')).toBe(false);
    expect(isFuelDailyPath('/cerca-lavoro-ticino/lugano/')).toBe(false);
    expect(isFuelDailyPath('/comparatori/cambio-valuta/')).toBe(false);
  });

  it('isFuelMonthArchivePath recognises YYYY-MM archive URLs', () => {
    expect(isFuelMonthArchivePath('/prezzi-diesel/chiasso/2026-03/')).toBe(true);
    expect(isFuelMonthArchivePath('/en/diesel-price-switzerland/lugano/2026-01/')).toBe(true);
    expect(isFuelMonthArchivePath('/prezzi-diesel/chiasso/oggi/')).toBe(false);
    expect(isFuelMonthArchivePath('/prezzi-diesel/2026-03/')).toBe(false); // missing zone
  });
});

describe('fuel-daily page generation — content quality', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelDailyPages({
    rootDir: '/tmp/frontaliere-fuel-daily-test',
    dataset: DATASET,
    history: [],
    today,
  });

  it('generates exactly 48 pages', () => {
    expect(Object.keys(pages)).toHaveLength(48);
  });

  it('every page has ≥250 words of visible content (F6 target)', () => {
    for (const [path, html] of Object.entries(pages)) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      expect(words, `page ${path} has only ${words} words`).toBeGreaterThanOrEqual(250);
    }
  });

  it('every page sets self-referencing canonical', () => {
    for (const [path, html] of Object.entries(pages)) {
      expect(html).toContain(`<link rel="canonical" href="https://frontaliereticino.ch${path}">`);
    }
  });

  it('every page has hreflang alternates for all 4 locales', () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain('hreflang="it"');
      expect(html).toContain('hreflang="en"');
      expect(html).toContain('hreflang="de"');
      expect(html).toContain('hreflang="fr"');
    }
  });

  it('every page has parseable BreadcrumbList + FAQPage JSON-LD', () => {
    for (const [path, html] of Object.entries(pages)) {
      const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(ldBlocks.length, `page ${path} has no JSON-LD blocks`).toBeGreaterThanOrEqual(2);
      const types = ldBlocks.map((m) => {
        const parsed = JSON.parse(m[1]);
        return parsed['@type'];
      });
      expect(types).toContain('BreadcrumbList');
      expect(types).toContain('WebPage');
      expect(types).toContain('FAQPage');
    }
  });

  it('every page with a price emits Product JSON-LD with CHF', () => {
    for (const [path, html] of Object.entries(pages)) {
      if (!html.includes('"@type":"Product"')) continue;
      const match = html.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
      if (!match) continue;
      const parsed = JSON.parse(match[1]);
      expect(parsed.offers.priceCurrency, `page ${path}`).toBe('CHF');
      expect(typeof parsed.offers.price).toBe('string');
    }
  });

  it('fuel Product JSON-LD includes merchant listing support fields', () => {
    for (const [path, html] of Object.entries(pages)) {
      if (!html.includes('"@type":"Product"')) continue;
      const match = html.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
      if (!match) continue;
      const parsed = JSON.parse(match[1]);
      expect(Array.isArray(parsed.image) ? parsed.image.length : 0, `page ${path}`).toBeGreaterThan(0);
      expect(typeof parsed.description, `page ${path}`).toBe('string');
      expect(parsed.description.length, `page ${path}`).toBeGreaterThan(20);
      expect(parsed.brand?.name, `page ${path}`).toBeTruthy();
      expect(parsed.offers.hasMerchantReturnPolicy?.returnPolicyCategory, `page ${path}`).toBe(
        'https://schema.org/MerchantReturnNotPermitted',
      );
      expect(parsed.offers.shippingDetails?.shippingDestination?.addressCountry, `page ${path}`).toBe('CH');
      expect(parsed.offers.shippingDetails?.shippingRate?.currency, `page ${path}`).toBe('CHF');
    }
  });

  it('fuel Product JSON-LD omits self-serving aggregateRating and review (Google structured-data policy Dec 2024)', () => {
    for (const [path, html] of Object.entries(pages)) {
      if (!html.includes('"@type":"Product"')) continue;
      const match = html.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
      if (!match) continue;
      const parsed = JSON.parse(match[1]);
      expect(parsed.aggregateRating, `page ${path}`).toBeUndefined();
      expect(parsed.review, `page ${path}`).toBeUndefined();
      expect(html, `page ${path}`).toMatch(/Valutazione editoriale|Editorial assessment|Redaktionelle Bewertung|Évaluation éditoriale/);
    }
  });

  it('includes localized H1 and no dark: color classes', () => {
    const itRegional = pages['/prezzi-diesel/oggi/'];
    expect(itRegional).toMatch(/<h1[^>]*>.*Prezzo Diesel Svizzera oggi/i);
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/\sdark:[a-z-]+/);
    }
  });

  it('locale coverage — exactly 4 locales × 2 fuels × 6 combos', () => {
    const byLocale: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const path of Object.keys(pages)) {
      if (path.startsWith('/en/')) byLocale.en++;
      else if (path.startsWith('/de/')) byLocale.de++;
      else if (path.startsWith('/fr/')) byLocale.fr++;
      else byLocale.it++;
    }
    for (const loc of ['it', 'en', 'de', 'fr']) {
      expect(byLocale[loc]).toBe(12); // 2 fuels × (1 regional + 5 zones)
    }
  });
});

describe('fuel-daily page generation — diesel data sourcing (F6 real diesel)', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');

  it('uses real per-station dieselPriceChf when available (not SP95+offset)', () => {
    // Isolated dataset: single Chiasso station with a non-derivable diesel
    // price. If the plugin derived diesel from SP95+0.08 we'd get 2.000 — the
    // real value is 2.123, which the rendered price must reflect.
    const isolated = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        {
          municipality: 'Test',
          province: 'CO',
          swiss: {
            nearbyStations: [
              { id: 'real-1', name: 'Real Diesel Station', brand: 'TEST', address: 'Via Test 1, 6830 Chiasso', sp95PriceChf: 1.92, dieselPriceChf: 2.123, dieselSource: 'api' as const },
            ],
          },
        },
      ],
    };
    const pages = generateFuelDailyPages({ rootDir: '/tmp/frontaliere-fuel-diesel-test', dataset: isolated, history: [], today });
    const chiassoDiesel = pages['/prezzi-diesel/chiasso/oggi/'];
    // Real diesel average = 2.123. SP95+offset would be 2.000.
    expect(chiassoDiesel).toContain('2,123');
    expect(chiassoDiesel).not.toContain('2,000 CHF');
  });

  it('falls back to SP95 + legacy offset when dieselPriceChf is missing', () => {
    const isolated = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        {
          municipality: 'Test',
          province: 'CO',
          swiss: {
            nearbyStations: [
              { id: 'fallback-1', name: 'Legacy Station', brand: 'TEST', address: 'Via Test 1, 6600 Locarno', sp95PriceChf: 1.90 },
            ],
          },
        },
      ],
    };
    const pages = generateFuelDailyPages({ rootDir: '/tmp/frontaliere-fuel-diesel-fallback', dataset: isolated, history: [], today });
    const locarnoDiesel = pages['/prezzi-diesel/locarno/oggi/'];
    // Fallback: 1.90 + 0.08 = 1.98
    expect(locarnoDiesel).toContain('1,980');
  });

  it('benzina price is unaffected by dieselPriceChf absence', () => {
    const isolated = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        {
          municipality: 'Test',
          province: 'CO',
          swiss: {
            nearbyStations: [
              { id: 'b1', name: 'Benzina Only', brand: 'TEST', address: 'Via Test 1, 6830 Chiasso', sp95PriceChf: 1.777 },
            ],
          },
        },
      ],
    };
    const pages = generateFuelDailyPages({ rootDir: '/tmp/frontaliere-fuel-benzina-test', dataset: isolated, history: [], today });
    const chiassoBenzina = pages['/prezzi-benzina/chiasso/oggi/'];
    expect(chiassoBenzina).toContain('1,777');
  });
});

describe('fuel-daily archive generation', () => {
  it('generates archives only for past months', () => {
    const today = new Date('2026-04-20T06:00:00.000Z');
    const history = [
      { date: '2026-03-01', zones: {}, regional: {} },
      { date: '2026-03-15', zones: {}, regional: {} },
      { date: '2026-04-01', zones: {}, regional: {} }, // current month — skipped
    ];
    // @ts-expect-error partial HistorySnapshot shape acceptable for this test
    const archives = generateFuelArchivePages({ history, today });
    for (const path of Object.keys(archives)) {
      expect(path.includes('2026-04')).toBe(false);
    }
    expect(Object.keys(archives).length).toBeGreaterThan(0);
  });

  it('returns empty object when history is empty', () => {
    const archives = generateFuelArchivePages({ history: [], today: new Date('2026-04-20') });
    expect(archives).toEqual({});
  });
});
