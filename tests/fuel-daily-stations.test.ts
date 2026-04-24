/**
 * Tests for D-2A fuel-station granular pages.
 *
 * Covers:
 *  - slug generation (buildStationSlug, slugify) — stable + URL-safe
 *  - path builders — Swiss per-station + IT-city + IT per-station URLs
 *  - Router matchers (isFuelStationPath, isFuelItalianCityPath,
 *    isFuelDailyPath accepts the new shapes)
 *  - City→zone resolution
 *  - generateFuelStationPages():
 *    - emits 1 page per (ticino-station × fuel × locale)
 *    - every page ≥250 words
 *    - canonical self-reference, hreflang complete
 *    - JSON-LD includes WebPage + BreadcrumbList + GasStation + Product
 *    - links back to zone hub
 *    - skips stations outside the Ticino zones
 */

import { describe, expect, it } from 'vitest';
import {
  FUEL_ITALIAN_CITIES,
  FUEL_STATIONS_SLUG,
  FUEL_ITALY_SLUG,
  buildFuelItalianCityPath,
  buildFuelItalianStationPath,
  buildFuelStationPath,
  buildStationSlug,
  extractCityFromAddress,
  findItalianCityBySlug,
  isFuelDailyPath,
  isFuelItalianCityPath,
  isFuelStationPath,
  slugify,
  zoneForAddress,
  type FuelZone,
} from '../build-plugins/fuelDailyData';
import {
  generateFuelStationPages,
  generateFuelItalianCityPages,
} from '../build-plugins/fuelDailyPagesPlugin';

// Minimal dataset mimicking the real fuel-prices.json shape.
// Covers 4 Ticino zones + 2 stations outside Ticino (Valais / Grisons) to
// verify the "only Ticino stations get per-station pages" rule.
const DATASET = {
  generatedAt: '2026-04-20T06:00:00.000Z',
  municipalities: [
    {
      municipality: 'Ronago',
      province: 'CO',
      swiss: {
        nearbyStations: [
          {
            id: 's1',
            name: 'Eni Chiasso',
            brand: 'ENI',
            address: 'Via Compolongo 12, 6830 Chiasso',
            sp95PriceChf: 1.78,
            dieselPriceChf: 1.95,
            dieselSource: 'api' as const,
            lat: 45.84,
            lng: 9.03,
            updatedAt: '2026-04-20T05:00:00.000Z',
          },
          {
            id: 's2',
            name: 'BP Balerna',
            brand: 'BP',
            address: 'Via San Gottardo 56, 6828 Balerna',
            sp95PriceChf: 1.80,
            dieselPriceChf: 1.98,
            dieselSource: 'api' as const,
            lat: 45.85,
            lng: 9.01,
          },
          {
            id: 's3',
            name: 'Eni Stabio',
            brand: 'ENI',
            address: 'Via Gaggiolo 28, 6855 Stabio',
            sp95PriceChf: 1.82,
            dieselPriceChf: 2.01,
            dieselSource: 'api' as const,
            lat: 45.85,
            lng: 8.93,
          },
          {
            id: 's4',
            name: 'Migrol Lugano',
            brand: 'MIGROL',
            address: 'Via Pioda 2, 6900 Lugano',
            sp95PriceChf: 1.84,
            dieselPriceChf: 2.03,
            dieselSource: 'api' as const,
          },
          {
            id: 's5',
            name: 'AVIA Bellinzona',
            brand: 'AVIA',
            address: 'Viale Portone 3, 6500 Bellinzona',
            sp95PriceChf: 1.83,
            dieselPriceChf: 2.02,
            dieselSource: 'api' as const,
          },
          // Station outside Ticino zones (Valais) — must be skipped
          {
            id: 's-out',
            name: 'Gondo Station',
            brand: 'AGROLA',
            address: 'Simplonstrasse, 3907 Gondo',
            sp95PriceChf: 1.81,
            dieselPriceChf: 2.00,
          },
          // Unidentifiable station (no brand + no name) — must be skipped
          {
            id: 's-nil',
            address: 'Via Chiasso 99, 6830 Chiasso',
            sp95PriceChf: 1.90,
          },
        ],
      },
      italy: {
        cheapestStation: {
          id: '1',
          stationName: 'Eni Como',
          brand: 'Eni',
          address: 'Via Milano 10, 22100 Como',
          priceEur: 1.759,
          lat: 45.81,
          lng: 9.08,
        },
      },
    },
    // Repeated municipalities shouldn't create duplicates (dedup by id+addr+name)
    {
      municipality: 'Cadegliano-Viconago',
      province: 'VA',
      swiss: {
        nearbyStations: [
          {
            id: 's1',
            name: 'Eni Chiasso',
            brand: 'ENI',
            address: 'Via Compolongo 12, 6830 Chiasso',
            sp95PriceChf: 1.78,
            dieselPriceChf: 1.95,
          },
        ],
      },
      italy: {
        cheapestStation: {
          id: '2',
          stationName: 'Q8 Varese',
          brand: 'Q8',
          address: 'Viale Europa 86, 21100 Varese',
          priceEur: 1.679,
        },
      },
    },
    // Italian city: Como alternate row
    {
      municipality: 'Como',
      province: 'CO',
      italy: {
        cheapestStation: {
          id: '3',
          stationName: 'Shell Como',
          brand: 'Shell',
          address: 'Via Bellinzona 100, 22100 Como',
          priceEur: 1.729,
        },
      },
    },
    // Varese
    {
      municipality: 'Varese',
      province: 'VA',
      italy: {
        cheapestStation: {
          id: '4',
          stationName: 'Esso Varese',
          brand: 'Esso',
          address: 'Via Sempione 42, 21100 Varese',
          priceEur: 1.699,
        },
      },
    },
  ],
};

describe('slugify()', () => {
  it('lowercases + kebab-cases plain strings', () => {
    expect(slugify('Via Compolongo')).toBe('via-compolongo');
    expect(slugify('Eni Stabio')).toBe('eni-stabio');
  });
  it('strips diacritics', () => {
    expect(slugify('Cantù')).toBe('cantu');
    expect(slugify('Müstair')).toBe('mustair');
  });
  it('strips punctuation + apostrophes', () => {
    expect(slugify("L'Azienda Sagl")).toBe('lazienda-sagl');
    expect(slugify('A.B. & Co.')).toBe('a-b-co');
  });
  it('handles empty/null input', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
  });
  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

describe('buildStationSlug()', () => {
  it('combines brand + street (without house number)', () => {
    expect(
      buildStationSlug({ brand: 'ENI', name: 'Eni Stabio', address: 'Via Gaggiolo 28, 6855 Stabio' }),
    ).toBe('eni-via-gaggiolo');
  });
  it('falls back to name-first-word when brand is UNDEFINED', () => {
    expect(
      buildStationSlug({ brand: 'UNDEFINED', name: 'Piccadilly SA', address: 'Via Gottardo 12, 6830 Chiasso' }),
    ).toBe('piccadilly-via-gottardo');
  });
  it('falls back to "stazione" when everything is empty', () => {
    expect(buildStationSlug({ brand: '', name: '', address: '' })).toBe('stazione');
  });
  it('handles addresses without house numbers', () => {
    expect(
      buildStationSlug({ brand: 'COOP', name: 'Coop', address: 'Via Zurigo, 6900 Lugano' }),
    ).toBe('coop-via-zurigo');
  });
});

describe('extractCityFromAddress() + zoneForAddress()', () => {
  it('extracts city from "street, CAP City" addresses', () => {
    expect(extractCityFromAddress('Via Foo 12, 6830 Chiasso')).toBe('chiasso');
    expect(extractCityFromAddress('Via Pioda 2, 6900 Lugano')).toBe('lugano');
    expect(extractCityFromAddress('Viale Portone 3, 6500 Bellinzona')).toBe('bellinzona');
  });
  it('returns null for unparseable addresses', () => {
    expect(extractCityFromAddress(null)).toBeNull();
    expect(extractCityFromAddress('')).toBeNull();
  });
  it('maps Ticino cities to the correct zone', () => {
    expect(zoneForAddress('Via Foo 12, 6830 Chiasso')).toBe('chiasso');
    expect(zoneForAddress('Via Foo 12, 6850 Mendrisio')).toBe('mendrisio');
    expect(zoneForAddress('Via Pioda 2, 6900 Lugano')).toBe('lugano');
    expect(zoneForAddress('Viale Portone 3, 6500 Bellinzona')).toBe('bellinzona');
    expect(zoneForAddress('Via San Gottardo 80, 6600 Locarno')).toBe('locarno');
  });
  it('returns null for stations outside Ticino zones', () => {
    expect(zoneForAddress('Simplonstrasse, 3907 Gondo')).toBeNull();
    expect(zoneForAddress('Via Rasia 1077, 23041 Livigno')).toBeNull();
  });
});

describe('buildFuelStationPath()', () => {
  it('builds Italian Swiss per-station paths', () => {
    expect(
      buildFuelStationPath('it', 'diesel', 'chiasso', 'eni-via-compolongo'),
    ).toBe('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/');
    expect(
      buildFuelStationPath('it', 'benzina', 'lugano', 'migrol-via-pioda'),
    ).toBe('/prezzi-benzina/lugano/stazioni/migrol-via-pioda/');
  });
  it('builds EN / DE / FR Swiss per-station paths', () => {
    expect(
      buildFuelStationPath('en', 'diesel', 'chiasso', 'eni-via-compolongo'),
    ).toBe('/en/diesel-price-switzerland/chiasso/stations/eni-via-compolongo/');
    expect(
      buildFuelStationPath('de', 'benzina', 'mendrisio', 'eni-via-gaggiolo'),
    ).toBe('/de/benzinpreis-schweiz/mendrisio/tankstellen/eni-via-gaggiolo/');
    expect(
      buildFuelStationPath('fr', 'diesel', 'bellinzona', 'avia-viale-portone'),
    ).toBe('/fr/prix-gasoil-suisse/bellinzona/stations/avia-viale-portone/');
  });
});

describe('buildFuelItalianCityPath()', () => {
  it('builds Italian city hub paths', () => {
    expect(buildFuelItalianCityPath('it', 'benzina', 'como')).toBe('/prezzi-benzina/italia/como/oggi/');
    expect(buildFuelItalianCityPath('it', 'diesel', 'varese')).toBe('/prezzi-diesel/italia/varese/oggi/');
  });
  it('builds EN / DE / FR city hub paths', () => {
    expect(buildFuelItalianCityPath('en', 'benzina', 'como')).toBe('/en/gasoline-price-switzerland/italy/como/today/');
    expect(buildFuelItalianCityPath('de', 'diesel', 'varese')).toBe('/de/dieselpreis-schweiz/italien/varese/heute/');
    expect(buildFuelItalianCityPath('fr', 'benzina', 'luino')).toBe('/fr/prix-essence-suisse/italie/luino/aujourd-hui/');
  });
});

describe('buildFuelItalianStationPath()', () => {
  it('builds Italian per-station paths', () => {
    expect(
      buildFuelItalianStationPath('it', 'benzina', 'como', 'eni-via-milano'),
    ).toBe('/prezzi-benzina/italia/como/stazioni/eni-via-milano/');
  });
});

describe('isFuelStationPath()', () => {
  it('recognises Swiss per-station canonical paths', () => {
    expect(isFuelStationPath('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/')).toBe(true);
    expect(isFuelStationPath('/en/diesel-price-switzerland/chiasso/stations/eni-via-compolongo/')).toBe(true);
    expect(isFuelStationPath('/de/benzinpreis-schweiz/lugano/tankstellen/migrol-via-pioda/')).toBe(true);
  });
  it('rejects non-station paths', () => {
    expect(isFuelStationPath('/prezzi-diesel/chiasso/oggi/')).toBe(false);
    expect(isFuelStationPath('/prezzi-diesel/oggi/')).toBe(false);
    expect(isFuelStationPath('/')).toBe(false);
  });
});

describe('isFuelItalianCityPath()', () => {
  it('recognises Italian city hub paths', () => {
    expect(isFuelItalianCityPath('/prezzi-benzina/italia/como/oggi/')).toBe(true);
    expect(isFuelItalianCityPath('/en/gasoline-price-switzerland/italy/varese/today/')).toBe(true);
  });
  it('rejects non-matching paths', () => {
    expect(isFuelItalianCityPath('/prezzi-benzina/chiasso/oggi/')).toBe(false);
    expect(isFuelItalianCityPath('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/')).toBe(false);
  });
});

describe('isFuelDailyPath() composite recognition', () => {
  it('accepts legacy + new patterns', () => {
    expect(isFuelDailyPath('/prezzi-diesel/oggi/')).toBe(true);
    expect(isFuelDailyPath('/prezzi-diesel/chiasso/oggi/')).toBe(true);
    expect(isFuelDailyPath('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/')).toBe(true);
    expect(isFuelDailyPath('/prezzi-benzina/italia/como/oggi/')).toBe(true);
    expect(isFuelDailyPath('/prezzi-diesel/chiasso/2026-03/')).toBe(true);
  });
  it('still rejects unrelated paths', () => {
    expect(isFuelDailyPath('/cerca-lavoro-ticino/')).toBe(false);
    expect(isFuelDailyPath('/')).toBe(false);
  });
});

describe('FUEL_ITALIAN_CITIES curated list', () => {
  it('contains the 15 key border cities', () => {
    expect(FUEL_ITALIAN_CITIES.length).toBe(15);
    const slugs = FUEL_ITALIAN_CITIES.map((c) => c.slug);
    expect(slugs).toContain('como');
    expect(slugs).toContain('varese');
    expect(slugs).toContain('luino');
  });
  it('each entry maps to a valid Ticino zone', () => {
    const validZones: FuelZone[] = ['chiasso', 'mendrisio', 'lugano', 'bellinzona', 'locarno'];
    for (const c of FUEL_ITALIAN_CITIES) {
      expect(validZones).toContain(c.nearestZone);
    }
  });
  it('findItalianCityBySlug returns the entry or null', () => {
    expect(findItalianCityBySlug('como')?.display).toBe('Como');
    expect(findItalianCityBySlug('nope-nope')).toBeNull();
  });
  it('FUEL_STATIONS_SLUG + FUEL_ITALY_SLUG defined for all locales', () => {
    for (const l of ['it', 'en', 'de', 'fr'] as const) {
      expect(typeof FUEL_STATIONS_SLUG[l]).toBe('string');
      expect(typeof FUEL_ITALY_SLUG[l]).toBe('string');
    }
  });
});

describe('generateFuelStationPages() — Ticino only', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelStationPages({ dataset: DATASET, today });

  it('generates pages for 5 unique Ticino stations × 2 fuels × 4 locales = 40', () => {
    expect(Object.keys(pages).length).toBe(40);
  });

  it('every page path follows the hub-and-spoke pattern', () => {
    for (const path of Object.keys(pages)) {
      expect(path).toMatch(/\/[^/]+\/(chiasso|mendrisio|lugano|bellinzona|locarno)\/(stazioni|stations|tankstellen)\/[^/]+\/$/);
    }
  });

  it('excludes stations outside Ticino (e.g. Gondo, Valais)', () => {
    for (const path of Object.keys(pages)) {
      expect(path).not.toContain('gondo');
    }
  });

  it('excludes unidentifiable stations (no brand + no name)', () => {
    // s-nil has no brand + no name → must be skipped regardless of price
    const values = Object.values(pages).join('\n');
    expect(values).not.toContain('s-nil');
  });

  it('every page has ≥250 words of visible content', () => {
    for (const [path, html] of Object.entries(pages)) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ').filter((w) => w.length > 0).length;
      expect(words, `page ${path}`).toBeGreaterThanOrEqual(250);
    }
  });

  it('every page has a self-referencing canonical', () => {
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

  it('every page emits WebPage + BreadcrumbList + GasStation + Product JSON-LD', () => {
    for (const [path, html] of Object.entries(pages)) {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(blocks.length, path).toBeGreaterThanOrEqual(4);
      const types = blocks.map((m) => JSON.parse(m[1])['@type']);
      expect(types, path).toContain('WebPage');
      expect(types, path).toContain('BreadcrumbList');
      expect(types, path).toContain('GasStation');
      expect(types, path).toContain('Product');
    }
  });

  it('GasStation JSON-LD carries postal address + country CH', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    expect(sample).toBeDefined();
    const m = sample.match(/<script type="application\/ld\+json">({[^<]*"@type":"GasStation"[^<]*})<\/script>/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed.address.addressCountry).toBe('CH');
    expect(parsed.address.addressLocality).toBe('Chiasso');
  });

  it('GasStation JSON-LD includes geo when lat/lng available', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    expect(sample).toContain('"geo"');
    expect(sample).toContain('"latitude":45.84');
  });

  it('Product JSON-LD carries CHF price', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    const m = sample.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed.offers.priceCurrency).toBe('CHF');
    expect(typeof parsed.offers.price).toBe('string');
  });

  it('Product JSON-LD includes image, description, brand, return policy and shipping details', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    const m = sample.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed.image).toEqual(['https://frontaliereticino.ch/og-image.png']);
    expect(parsed.description).toMatch(/Eni/);
    expect(parsed.brand?.name).toBe('Eni');
    expect(parsed.sku).toBe('fuel-diesel-chiasso-eni-via-compolongo');
    expect(parsed.offers.availability).toBe('https://schema.org/InStoreOnly');
    expect(parsed.offers.hasMerchantReturnPolicy?.applicableCountry).toBe('CH');
    expect(parsed.offers.hasMerchantReturnPolicy?.returnPolicyCategory).toBe(
      'https://schema.org/MerchantReturnNotPermitted',
    );
    expect(parsed.offers.shippingDetails?.shippingDestination?.addressCountry).toBe('CH');
    expect(parsed.offers.shippingDetails?.shippingRate?.value).toBe(0);
    expect(parsed.offers.shippingDetails?.shippingRate?.currency).toBe('CHF');
    expect(parsed.offers.shippingDetails?.deliveryTime?.handlingTime?.unitCode).toBe('DAY');
  });

  it('Product JSON-LD omits self-serving aggregateRating/review, keeps visible editorial assessment prose (Google structured-data policy Dec 2024)', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    const m = sample.match(/<script type="application\/ld\+json">({[^<]*"@type":"Product"[^<]*})<\/script>/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed.aggregateRating).toBeUndefined();
    expect(parsed.review).toBeUndefined();
    expect(sample).toMatch(/Recensione editoriale della stazione/);
  });

  it('every page links back to the zone hub', () => {
    for (const [path, html] of Object.entries(pages)) {
      const zoneMatch = path.match(/\/(chiasso|mendrisio|lugano|bellinzona|locarno)\//);
      expect(zoneMatch).toBeTruthy();
      const zone = zoneMatch![1];
      // Match the hub path in either locale (IT "oggi" / EN "today" / etc.)
      expect(html).toMatch(new RegExp(`/${zone}/(oggi|today|heute|aujourd-hui)/`));
    }
  });

  it('h1 contains brand + city', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    expect(sample).toMatch(/<h1[^>]*>[^<]*Eni/);
    expect(sample).toMatch(/Chiasso/);
  });

  it('uses <body class="bg-surface-alt"> SPA shell with empty #root + static seo-content sibling', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    expect(sample).toContain('bg-surface-alt');
    // #root is left EMPTY on SEO pages so React's hydration cannot visually
    // replace the static SEO content (bait-and-switch fix).
    expect(sample).toMatch(/<div id="root"><\/div>/);
    // SEO content lives in a sibling `<main class="seo-static-content">`.
    expect(sample).toContain('<main class="seo-static-content">');
  });

  it('does not leak any dark: color prefix classes', () => {
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/\sdark:[a-z-]+/);
    }
  });

  it('respects MAX_FUEL_STATION_PAGES_PER_BUILD cap', () => {
    const capped = generateFuelStationPages({ dataset: DATASET, today, maxPages: 3 });
    expect(Object.keys(capped).length).toBe(3);
  });
});

describe('generateFuelStationPages() — sibling links', () => {
  const today = new Date('2026-04-20T06:00:00.000Z');
  const pages = generateFuelStationPages({ dataset: DATASET, today });

  it('page for Eni Chiasso links to BP Balerna (same zone sibling)', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    // BP Balerna slug should appear in the sibling related-links block
    expect(sample).toContain('bp-via-san-gottardo');
  });

  it('page includes a related-links nav block', () => {
    const sample = pages['/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/'];
    expect(sample).toMatch(/<nav[^>]*id="seoRelatedLinks"/);
  });
});
