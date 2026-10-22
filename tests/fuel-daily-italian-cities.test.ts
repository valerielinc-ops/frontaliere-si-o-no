/**
 * Tests for D-2A per-Italian-city fuel hub pages.
 *
 * Covers:
 *  - generateFuelItalianCityPages emits pages for cities with data
 *  - Cities without data are skipped (no thin pages)
 *  - Canonical + hreflang + JSON-LD correctness
 *  - ≥250 words per page
 *  - Cross-link to nearest Ticino zone + border-wait for commuter flow
 *  - Proper top-10 stations table rendering
 */

import { describe, expect, it } from 'vitest';
import { isFuelDailyPath } from '../build-plugins/fuelDailyData';
import { generateFuelItalianCityPages } from '../build-plugins/fuelDailyPagesPlugin';
import { htmlAttr, htmlTagWithAttrs, htmlTagWithClass } from './utils/htmlAttr';
import { extractFuelBreadcrumbTargets } from './utils/fuelBreadcrumbs';

const DATASET = {
  generatedAt: '2026-04-20T06:00:00.000Z',
  municipalities: [
    {
      municipality: 'Como',
      province: 'CO',
      italy: {
        cheapestStation: {
          id: '1',
          stationName: 'Eni Como',
          brand: 'Eni',
          address: 'Via Milano 10, 22100 Como',
          priceEur: 1.759,
          dieselPriceEur: 1.829,
          lat: 45.81,
          lng: 9.08,
        },
      },
    },
    {
      municipality: 'Como',
      province: 'CO',
      italy: {
        cheapestStation: {
          id: '2',
          stationName: 'Shell Como',
          brand: 'Shell',
          address: 'Via Bellinzona 50, 22100 Como',
          priceEur: 1.739,
          dieselPriceEur: 1.799,
          lat: 45.81,
          lng: 9.07,
        },
      },
    },
    {
      municipality: 'Varese',
      province: 'VA',
      italy: {
        cheapestStation: {
          id: '3',
          stationName: 'Q8 Varese',
          brand: 'Q8',
          address: 'Viale Europa 86, 21100 Varese',
          priceEur: 1.679,
          dieselPriceEur: 1.749,
        },
      },
    },
    {
      municipality: 'Luino',
      province: 'VA',
      italy: {
        cheapestStation: {
          id: '4',
          stationName: 'Tamoil Luino',
          brand: 'Tamoil',
          address: 'Via XXV Aprile 12, 21016 Luino',
          priceEur: 1.759,
          dieselPriceEur: 1.819,
        },
      },
    },
    // Città fuori lista curata — non deve generare pagina
    {
      municipality: 'Bergamo',
      province: 'BG',
      italy: {
        cheapestStation: {
          id: '99',
          stationName: 'Eni Bergamo',
          address: 'Via Milano 1, 24100 Bergamo',
          priceEur: 1.65,
        },
      },
    },
  ],
};

describe('generateFuelItalianCityPages() — coverage', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelItalianCityPages({ dataset: DATASET, today });

  it('emits exactly 3 cities × 2 fuels × 4 locales = 24 pages', () => {
    // Only Como, Varese, Luino have data in the curated FUEL_ITALIAN_CITIES list
    expect(Object.keys(pages).length).toBe(24);
  });

  it('does not emit pages for cities outside the curated list', () => {
    for (const path of Object.keys(pages)) {
      expect(path).not.toContain('bergamo');
    }
  });

  it('does not emit pages for curated cities with no dataset entry', () => {
    // Gallarate, Lecco etc. are in FUEL_ITALIAN_CITIES but not in DATASET
    for (const path of Object.keys(pages)) {
      expect(path).not.toContain('gallarate');
      expect(path).not.toContain('lecco');
    }
  });

  it('paths follow the /prezzi-{fuel}/italia/{city}/oggi/ pattern', () => {
    for (const path of Object.keys(pages)) {
      expect(path).toMatch(/\/(prezzi-diesel|prezzi-benzina|diesel-price-switzerland|gasoline-price-switzerland|dieselpreis-schweiz|benzinpreis-schweiz|prix-gasoil-suisse|prix-essence-suisse)\/(italia|italy|italien|italie)\/(como|varese|luino)\/(oggi|today|heute|aujourd-hui)\/$/);
    }
  });
});

describe('generateFuelItalianCityPages() — content quality', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelItalianCityPages({ dataset: DATASET, today });

  it('every page has ≥250 words', () => {
    for (const [path, html] of Object.entries(pages)) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      expect(words, `page ${path}`).toBeGreaterThanOrEqual(250);
    }
  });

  it('every page has a self-referencing canonical', () => {
    for (const [path, html] of Object.entries(pages)) {
      expect(html).toMatch(htmlTagWithAttrs('link', {
        rel: 'canonical',
        href: `https://frontaliereticino.ch${path}`,
      }));
    }
  });

  it('every page has hreflang alternates for all 4 locales', () => {
    for (const html of Object.values(pages)) {
      expect(html).toMatch(htmlAttr('hreflang', 'it'));
      expect(html).toMatch(htmlAttr('hreflang', 'en'));
      expect(html).toMatch(htmlAttr('hreflang', 'de'));
      expect(html).toMatch(htmlAttr('hreflang', 'fr'));
    }
  });

  it('every page emits WebPage + BreadcrumbList + ItemList JSON-LD', () => {
    for (const [path, html] of Object.entries(pages)) {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      const types = blocks.map((m) => JSON.parse(m[1])['@type']);
      expect(types, path).toContain('WebPage');
      expect(types, path).toContain('BreadcrumbList');
      expect(types, path).toContain('ItemList');
    }
  });

  it('breadcrumb targets use emitted fuel routes', () => {
    for (const [path, html] of Object.entries(pages)) {
      const targets = extractFuelBreadcrumbTargets(html);
      expect(targets.jsonLd, `page ${path} has no JSON-LD breadcrumbs`).not.toHaveLength(0);
      expect(targets.visible, `page ${path} has no visible breadcrumbs`).not.toHaveLength(0);
      for (const target of [...targets.jsonLd, ...targets.visible]) {
        if (target === '/') continue;
        expect(isFuelDailyPath(target), `${path} breadcrumb target ${target}`).toBe(true);
      }
    }
  });

  it('ItemList JSON-LD contains the stations observed for that city', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(comoPage).toBeDefined();
    const m = comoPage.match(/<script type="application\/ld\+json">({[^<]*"@type":"ItemList"[^<]*})<\/script>/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed.numberOfItems).toBeGreaterThan(0);
    expect(parsed.itemListElement.length).toBeGreaterThan(0);
  });

  it('h1 mentions the city + fuel', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(comoPage).toMatch(/<h1[^>]*>.*Como/);
    const varesePage = pages['/prezzi-diesel/italia/varese/oggi/'];
    expect(varesePage).toMatch(/<h1[^>]*>.*Varese/);
  });

  it('body contains a stations table with station names', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(comoPage).toContain('Eni Como');
    expect(comoPage).toContain('Shell Como');
  });

  it('renders the calculator on a data-driven Livigno page and leaves unknown converted prices blank', () => {
    const livignoData = {
      generatedAt: '2026-10-20T06:00:00.000Z',
      municipalities: [{
        municipality: 'Livigno',
        province: 'SO',
        italy: { stations: [{ id: 'livigno-1', stationName: 'Livigno Sample', brand: 'Test', address: 'Via Rasia 1, 23041 Livigno', priceEur: 1.206, benzinaUpdatedAt: '2026-10-20', isSelf: true, updatedAt: '2026-10-20T06:00:00.000Z' }] },
        swiss: { nearbyStations: [{ id: 'swiss-1', name: 'Swiss Sample', brand: 'Test', address: 'Via del Forno 1, Zernez', sp95PriceChf: 1.9, updatedAt: '2026-10-20T06:00:00.000Z' }] },
      }],
    } as never;
    const livignoPages = generateFuelItalianCityPages({ dataset: livignoData, today: new Date('2026-10-20T06:00:00.000Z') });
    const html = livignoPages['/prezzi-benzina/italia/livigno/oggi/'];

    expect(html).toContain('data-fuel-trip-calculator');
    expect(html).toContain('data-currency=EUR');
    expect(html).toContain('value=1.206');
    expect(html).toMatch(/data-fuel-trip-field=alternativePrice[^>]*value(?:="")?(?:\s|>)/);
    expect(html).toContain('Self-service');
    expect(html).toContain('Prezzo rilevato: 20/10/2026');
  });

  it('uses a dated ECB conversion to prefill the Swiss city comparison and marks sample gross savings', () => {
    const livignoData = {
      generatedAt: '2026-10-20T06:00:00.000Z',
      sources: { exchangeRate: {
        provider: 'ECB',
        sourceUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
        rateDate: '2026-10-16',
        chfPerEur: 0.95,
        eurPerChf: 1 / 0.95,
      } },
      municipalities: [{
        municipality: 'Livigno',
        province: 'SO',
        italy: { stations: [{ id: 'livigno-1', stationName: 'Livigno Sample', brand: 'Test', address: 'Via Rasia 1, 23041 Livigno', priceEur: 1.206, isSelf: true, updatedAt: '2026-10-20T06:00:00.000Z' }] },
        swiss: { nearbyStations: [{ id: 'swiss-1', name: 'Swiss Sample', brand: 'Test', address: 'Via del Forno 1, Zernez', sp95PriceChf: 1.9, updatedAt: '2026-10-20T06:00:00.000Z' }] },
      }],
    } as never;
    const livignoPages = generateFuelItalianCityPages({ dataset: livignoData, today: new Date('2026-10-20T06:00:00.000Z') });
    const html = livignoPages['/prezzi-benzina/italia/livigno/oggi/'];

    expect(html).toContain('Cambio BCE applicato');
    expect(html).toContain('16/10/2026');
    expect(html).toMatch(/data-fuel-trip-field=alternativePrice[^>]*value=2(?:\s|>)/);
    expect(html).toContain('Differenza lorda sui prezzi del campione');
    expect(html).not.toMatch(/conviene fare il pieno/i);
  });

  it('body contains cross-link to the nearest Ticino zone hub', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    // Como nearestZone = chiasso
    expect(comoPage).toContain('/prezzi-benzina/chiasso/oggi/');
  });

  it('Luino page cross-links to Locarno (nearest zone for Luino)', () => {
    const luinoPage = pages['/prezzi-benzina/italia/luino/oggi/'];
    expect(luinoPage).toContain('/prezzi-benzina/locarno/oggi/');
  });

  it('uses SPA shell (bg-surface-alt) with empty #root + static seo-content sibling', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(comoPage).toContain('bg-surface-alt');
    // #root carries NO SEO content. No SPA bundle in this test env → the
    // header-reserve spacer is gated OFF and #root is plain-empty (safe
    // no-bundle degrade); the spacer-when-bundled path is unit-tested in
    // tests/build-plugins/rootShell.test.ts.
    expect(comoPage).toMatch(/<div\b[^>]*\bid=["']?root["']?(?=[\s>])[^>]*><\/div>/);
    expect(comoPage).not.toMatch(/<div\b[^>]*\bid=["']?root["']?[^>]*>\s*<main/);
    expect(comoPage).toMatch(htmlTagWithClass('main', 'seo-static-content'));
  });

  it('does not leak any dark: color prefix classes', () => {
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/\sdark:[a-z-]+/);
    }
  });

  it('emits a related-links nav block (fuel_italian_city type)', () => {
    const comoPage = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(comoPage).toMatch(htmlTagWithAttrs('nav', { id: 'seoRelatedLinks' }));
  });
});

describe('generateFuelItalianCityPages() — locale parity', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelItalianCityPages({ dataset: DATASET, today });

  it('emits same number of pages per locale', () => {
    const counts: Record<string, number> = { it: 0, en: 0, de: 0, fr: 0 };
    for (const path of Object.keys(pages)) {
      if (path.startsWith('/en/')) counts.en++;
      else if (path.startsWith('/de/')) counts.de++;
      else if (path.startsWith('/fr/')) counts.fr++;
      else counts.it++;
    }
    expect(counts.it).toBe(counts.en);
    expect(counts.en).toBe(counts.de);
    expect(counts.de).toBe(counts.fr);
    expect(counts.it).toBe(6); // 3 cities × 2 fuels
  });
});

describe('generateFuelItalianCityPages() — empty dataset', () => {
  it('returns {} when municipalities array is empty', () => {
    const empty = { generatedAt: '2026-04-20', municipalities: [] };
    const out = generateFuelItalianCityPages({ dataset: empty, today: new Date() });
    expect(out).toEqual({});
  });
});

describe('generateFuelItalianCityPages() — matchKey collision guard', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');

  const pricedStation = (id: string, name: string) => ({
    municipality: name,
    italy: {
      stations: [
        {
          id,
          stationName: `Eni ${name}`,
          brand: 'Eni',
          address: `Via Roma 1, ${name}`,
          priceEur: 1.7,
        },
      ],
    },
  });

  it('throws when two homonym comuni live in different provinces', () => {
    // Two distinct "Trezzano" municipalities (a real homonym risk in MIMIT data):
    // one in MI, one in a different province. Without the guard the second would be
    // dropped silently and its station merged onto the first city's page.
    const dataset = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        { ...pricedStation('a', 'Trezzano'), province: 'MI' },
        { ...pricedStation('b', 'Trezzano'), province: 'PV' },
      ],
    };
    expect(() => generateFuelItalianCityPages({ dataset, today })).toThrow(
      /matchKey collision/,
    );
  });

  it('does NOT throw for same-name same-province duplicate rows', () => {
    // Legitimate duplicate (same comune listed twice) must still dedup quietly.
    const dataset = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        { ...pricedStation('a', 'Trezzano'), province: 'MI' },
        { ...pricedStation('b', 'Trezzano'), province: 'MI' },
      ],
    };
    expect(() => generateFuelItalianCityPages({ dataset, today })).not.toThrow();
  });
});

describe('generateFuelItalianCityPages() — station brand logos', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  // rootDir = repo root so the build-time fs probe finds the real brand SVGs
  // under public/images/brands/ (eni→agipeni.svg via the shared alias map,
  // q8.svg, shell.svg, tamoil.svg). Without rootDir the card falls back to the
  // neutral fuel-pump icon — the "logo if available" contract.
  const rootDir = process.cwd();

  it('renders the brand logo <img> when rootDir resolves a logo on disk', () => {
    const pages = generateFuelItalianCityPages({ dataset: DATASET, today, rootDir });
    const como = pages['/prezzi-benzina/italia/como/oggi/'];
    // "Eni" maps to agipeni.svg through the shared BRAND_LOGO_ALIASES map.
    expect(como).toMatch(
      htmlTagWithAttrs('img', { src: '/images/brands/agipeni.svg', alt: 'Eni' }),
    );
    const varese = pages['/prezzi-benzina/italia/varese/oggi/'];
    expect(varese).toMatch(
      htmlTagWithAttrs('img', { src: '/images/brands/q8.svg', alt: 'Q8' }),
    );
  });

  it('omits brand <img> and keeps the neutral icon when rootDir is absent', () => {
    const pages = generateFuelItalianCityPages({ dataset: DATASET, today });
    for (const path of Object.keys(pages)) {
      expect(pages[path]).not.toContain('/images/brands/');
    }
  });
});
