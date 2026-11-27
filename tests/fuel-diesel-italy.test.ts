/**
 * MIMIT-Gasolio (diesel) Italian-side coverage.
 *
 * Before this feature the Italian city/station pages were benzina-only: the
 * diesel pages reused benzina prices and never linked per-station detail
 * pages (the station rows were a plain non-clickable table). The ingestion
 * now imports Gasolio into `dieselPriceEur`, so diesel pages must:
 *   1. show real diesel prices (not the benzina value),
 *   2. render clickable per-station cards → emit diesel station pages,
 *   3. expose a diesel Italian-stations browseable index linking every leaf
 *      (orphan contract), and
 *   4. render the cross-border "verdict + value badge" banner.
 *
 * Stations without a Gasolio price must be excluded from indexable diesel
 * pages, preserved as noindex bridges, and still appear on benzina pages.
 */

import { describe, expect, it } from 'vitest';
import {
  generateFuelItalianCityPages,
  generateFuelItalianStationPages,
  generateFuelItalianStationAvailabilityBridges,
  buildItalianStationPagesManifest,
} from '../build-plugins/fuelDailyPagesPlugin';
import { resolveItalianStationRoute } from '../scripts/lib/fuel-italian-station-routes.mjs';
import { buildFuelItalianStationPath, buildStationSlug } from '../build-plugins/fuelDailyData';
import { buildStationSlug as buildTwinStationSlug } from '../scripts/lib/fuel-station-slug.mjs';
import {
  generateFuelIndexPages,
  buildFuelIndexPath,
  type ItalianStationLeaf,
} from '../build-plugins/fuelStationIndexPages';
import {
  buildDataset,
  buildItalyFirestoreDoc,
  italyRouteMemoryByMunicipality,
} from '../scripts/generate-fuel-prices-dataset.mjs';

const TODAY = new Date('2026-05-18T06:00:00Z');

// Como is in the curated FUEL_ITALIAN_CITIES list. Two stations carry diesel,
// one is benzina-only (must be dropped from diesel pages).
const DATASET = {
  generatedAt: TODAY.toISOString(),
  sources: { exchangeRate: {
    provider: 'ECB',
    sourceUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
    rateDate: '2026-05-15',
    chfPerEur: 1,
    eurPerChf: 1,
  } },
  municipalities: [
    {
      municipality: 'Como',
      province: 'CO',
      italy: {
        stations: [
          { id: 'd1', brand: 'Eni', stationName: 'Eni Como', address: 'Via del Dos 14, 22100 Como', priceEur: 1.919, dieselPriceEur: 1.829, benzinaUpdatedAt: '2026-05-10', dieselUpdatedAt: '2026-05-11', updatedAt: '2026-05-17', isSelf: true, lat: 45.81, lng: 9.08 },
          { id: 'd2', brand: 'Q8', stationName: 'Q8 Como', address: 'Via Varesina 128, 22100 Como', priceEur: 1.939, dieselPriceEur: 1.799, benzinaUpdatedAt: '2026-05-12', dieselUpdatedAt: '2026-05-13', updatedAt: '2026-05-17', isSelf: true, lat: 45.80, lng: 9.07 },
          { id: 'b1', brand: 'Shell', stationName: 'Shell Como', address: 'Viale Rosselli 19, 22100 Como', priceEur: 1.959, dieselPriceEur: null, benzinaUpdatedAt: '2026-05-14', updatedAt: '2026-05-17', isSelf: true, lat: 45.79, lng: 9.06 },
        ],
      },
      swiss: {
        // `cheapestStation`/`nearbyStations` are ranked + truncated by sp95
        // (benzina). The genuinely diesel-cheapest pump (ch3, 1.870) ranks
        // outside the sp95 top-5 and is persisted separately as
        // `cheapestDieselStation`. The verdict must use THAT, not the diesel
        // price of the benzina-cheapest pump (2.327) nor the nearby min (1.950).
        cheapestStation: { id: 'ch1', name: 'Silo', brand: 'Migrol', address: 'Chiasso', sp95PriceChf: 2.009, sp95PriceEur: 2.009, dieselPriceChf: 2.327, dieselPriceEur: 2.327 },
        nearbyStations: [
          { id: 'ch1', name: 'Silo', brand: 'Migrol', address: 'Chiasso', sp95PriceChf: 2.009, sp95PriceEur: 2.009, dieselPriceChf: 2.327, dieselPriceEur: 2.327 },
          { id: 'ch2', name: 'Coop', brand: 'Coop', address: 'Maslianico', sp95PriceChf: 2.099, sp95PriceEur: 2.099, dieselPriceChf: 1.950, dieselPriceEur: 1.950 },
        ],
        cheapestDieselStation: { id: 'ch3', name: 'Tamoil', brand: 'Tamoil', address: 'Vacallo', sp95PriceChf: 2.180, sp95PriceEur: 2.180, dieselPriceChf: 1.870, dieselPriceEur: 1.870 },
      },
    },
  ],
} as never;

function countAnchors(html: string, hrefSubstr: string): number {
  const re = /<a\b[^>]*\shref\s*=\s*"([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html)) !== null) if (m[1].includes(hrefSubstr)) n++;
  return n;
}

describe('diesel Italian city pages — real diesel prices + clickable stations', () => {
  const pages = generateFuelItalianCityPages({ dataset: DATASET, today: TODAY });

  it('dates a city page with the day of its prices, for the sitemap', () => {
    const lastmodByPath = new Map<string, string>();
    generateFuelItalianCityPages({ dataset: DATASET, today: TODAY, lastmodByPath });
    const day = lastmodByPath.get('/prezzi-diesel/italia/como/oggi/');
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(day).not.toBe(TODAY.toISOString().slice(0, 10));
  });

  it('emits the diesel city page for Como', () => {
    expect(pages['/prezzi-diesel/italia/como/oggi/']).toBeDefined();
  });

  it('diesel page shows the diesel minimum (1,799), not the benzina minimum (1,919)', () => {
    const html = pages['/prezzi-diesel/italia/como/oggi/']!;
    // IT locale formats prices with a comma decimal separator.
    expect(html).toContain('1,799');
    // Benzina-only price must not leak in as the headline minimum tile.
    expect(html).not.toMatch(/Prezzo minimo[\s\S]{0,80}1,919/);
  });

  it('diesel page links per-station detail pages (clickable, not a dead table)', () => {
    const html = pages['/prezzi-diesel/italia/como/oggi/']!;
    expect(countAnchors(html, '/prezzi-diesel/italia/como/stazioni/')).toBeGreaterThanOrEqual(2);
  });

  it('renders the observation date belonging to each fuel, not the legacy row timestamp', () => {
    const diesel = pages['/prezzi-diesel/italia/como/oggi/']!;
    const benzina = pages['/prezzi-benzina/italia/como/oggi/']!;
    expect(benzina).toContain('10/05/2026');
    expect(benzina).toContain('12/05/2026');
    expect(benzina).not.toContain('11/05/2026');
    expect(diesel).toContain('11/05/2026');
    expect(diesel).toContain('13/05/2026');
    expect(diesel).not.toContain('10/05/2026');
    expect(diesel).not.toContain('17/05/2026');
  });

  it('leaves Italian observation date unknown when a legacy cache only has ambiguous updatedAt', () => {
    const legacyDataset = structuredClone(DATASET) as {
      municipalities: Array<{ italy?: { stations?: Array<Record<string, unknown>> } }>;
    };
    for (const municipality of legacyDataset.municipalities) {
      for (const station of municipality.italy?.stations ?? []) {
        delete station.benzinaUpdatedAt;
        delete station.dieselUpdatedAt;
        station.updatedAt = '2025-01-01';
      }
    }
    const legacyPages = generateFuelItalianCityPages({ dataset: legacyDataset as never, today: TODAY });
    const diesel = legacyPages['/prezzi-diesel/italia/como/oggi/']!;
    expect(diesel).not.toContain('01/01/2025');
    expect(diesel).toContain('Data del prezzo iniziale: data non disponibile');
  });

  it('excludes the benzina-only station from the diesel page but keeps it on benzina', () => {
    const diesel = pages['/prezzi-diesel/italia/como/oggi/']!;
    const benzina = pages['/prezzi-benzina/italia/como/oggi/']!;
    expect(diesel).not.toContain('Shell Como');
    expect(benzina).toContain('Shell Como');
  });

  it('renders the cross-border verdict banner using the true CH diesel minimum', () => {
    const html = pages['/prezzi-diesel/italia/como/oggi/']!;
    expect(html).toContain('s-itVerdict');
    // The gross sample difference uses cheapestDieselStation (|1.870−1.799|×50 = 3.55), NOT the
    // sp95-truncated nearby min (|1.950−1.799|×50 = 7.55) nor the benzina-
    // cheapest pump's diesel (|2.327−1.799|×50 = 26.40).
    expect(html).toContain('Differenza lorda sui prezzi del campione: 3,55 € su 50 L');
    expect(html).not.toMatch(/conviene fare il pieno in Italia/i);
    expect(html).toContain('3,55');
    expect(html).not.toContain('7,55');
    expect(html).not.toContain('26,40');
  });

  it('verdict falls back to cheapestStation when nearby/diesel-ranked lists are absent', () => {
    // Production shape until the crawler populates nearbyStations[].dieselPriceEur
    // + cheapestDieselStation: only `cheapestStation` carries the CH diesel price.
    const fallbackDataset = {
      generatedAt: TODAY.toISOString(),
      sources: DATASET.sources,
      municipalities: [
        {
          municipality: 'Como',
          province: 'CO',
          italy: {
            stations: [
              { id: 'd1', brand: 'Eni', stationName: 'Eni Como', address: 'Via del Dos 14, 22100 Como', priceEur: 1.919, dieselPriceEur: 1.799, isSelf: true },
            ],
          },
          swiss: {
            cheapestStation: { id: 'ch1', name: 'Silo', brand: 'Migrol', address: 'Chiasso', sp95PriceChf: 2.009, sp95PriceEur: 2.009, dieselPriceChf: 1.900, dieselPriceEur: 1.900 },
          },
        },
      ],
    } as never;
    const fbPages = generateFuelItalianCityPages({ dataset: fallbackDataset, today: TODAY });
    const html = fbPages['/prezzi-diesel/italia/como/oggi/']!;
    expect(html).toContain('s-itVerdict');
    // IT 1.799 < CH cheapestStation diesel 1.900 → sample gross difference = 5.05.
    expect(html).toContain('Differenza lorda sui prezzi del campione: 5,05 € su 50 L');
    expect(html).not.toMatch(/conviene fare il pieno in Italia/i);
    expect(html).toContain('5,05');
  });
});

describe('diesel Italian station pages — emitted per fuel', () => {
  const pages = generateFuelItalianStationPages({ dataset: DATASET, today: TODAY });
  const dieselPaths = Object.keys(pages).filter((p) => p.startsWith('/prezzi-diesel/italia/como/stazioni/'));

  it('emits diesel station detail pages for stations with a Gasolio price', () => {
    expect(dieselPaths.length).toBeGreaterThanOrEqual(2);
  });

  it('does not emit a diesel station page for the benzina-only station', () => {
    const all = Object.keys(pages).join('\n');
    // Shell (b1) slug would contain "shell"/"rosselli"; assert no diesel page for it.
    expect(all).not.toMatch(/prezzi-diesel\/italia\/como\/stazioni\/[^/]*rosselli/);
  });

  it('keeps the benzina-only station route as a noindex bridge when diesel disappears', () => {
    const bridges = generateFuelItalianStationAvailabilityBridges({ dataset: DATASET });
    const bridge = Object.entries(bridges).find(([pagePath]) =>
      pagePath.startsWith('/prezzi-diesel/italia/como/stazioni/') && /rosselli/.test(pagePath),
    );

    expect(bridge).toBeDefined();
    const [bridgePath, html] = bridge!;
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(pages[bridgePath]).toBeUndefined();
  });

  it('reserves the missing-price station slug so a colliding station keeps its prior URL', () => {
    const collisionDataset = structuredClone(DATASET) as unknown as {
      municipalities: Array<{
        municipality?: string;
        italy?: { stations?: Array<Record<string, unknown>> };
      }>;
    };
    const como = collisionDataset.municipalities.find((municipality) => municipality.municipality === 'Como');
    if (!como?.italy?.stations) throw new Error('Expected the Como station fixture.');
    como.italy.stations.push({
      id: 'b2',
      brand: 'Shell',
      stationName: 'Shell Como',
      address: 'Viale Rosselli 19, 22100 Como',
      priceEur: 1.969,
      dieselPriceEur: 1.899,
      isSelf: true,
    });

    const collisionPages = generateFuelItalianStationPages({ dataset: collisionDataset as never, today: TODAY });
    const bridges = generateFuelItalianStationAvailabilityBridges({ dataset: collisionDataset as never });
    const unavailablePath = Object.keys(bridges).find((pagePath) =>
      pagePath.startsWith('/prezzi-diesel/italia/como/stazioni/') && /rosselli/.test(pagePath),
    );
    const indexablePath = Object.keys(collisionPages).find((pagePath) =>
      pagePath.startsWith('/prezzi-diesel/italia/como/stazioni/') && /rosselli/.test(pagePath),
    );

    expect(unavailablePath).toBeDefined();
    expect(indexablePath).toBeDefined();
    expect(unavailablePath).not.toBe(indexablePath);
    expect(unavailablePath).toMatch(/\/stazioni\/[^/]*rosselli[^/]*\/$/);
    expect(indexablePath).toMatch(/\/stazioni\/[^/]*rosselli[^/]*-2\/$/);
  });
});

// Publisher run 45059292727: MIMIT stopped listing one Q8 station at all, so the
// refreshed dataset no longer knew its routes, no bridge was emitted for its 8
// URLs and the publisher gate refused the fuel-italian-stations decrease.
describe('Italian station pages — a station leaving the MIMIT cut keeps its URLs', () => {
  const COMO = { name: 'Como', province: 'CO', lat: 45.81, lng: 9.08 };
  type Row = Record<string, unknown>;
  const rows = (DATASET as unknown as { municipalities: Array<{ italy: { stations: Row[] } }> })
    .municipalities[0].italy.stations;
  // Two namesakes on one street, so their slugs differ only by the `-2` suffix.
  const twin = { ...rows[2], id: 'b2', priceEur: 1.969, dieselPriceEur: 1.899 };
  const before = [...rows, twin];

  const refresh = (previousDataset: unknown, current: Row[]) => {
    const italyByMunicipality = new Map([['Como:CO', current]]);
    return buildDataset({
      municipalities: [COMO],
      italyExtractedAt: TODAY.toISOString().slice(0, 10),
      swissStations: [],
      italyByMunicipality,
      italyRouteMemory: italyRouteMemoryByMunicipality(previousDataset, italyByMunicipality),
      exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
    });
  };
  const stationPaths = (dataset: unknown) => Object.keys(
    generateFuelItalianStationPages({ dataset: dataset as never, today: TODAY }),
  );
  const first = refresh(null, before);

  it.each([
    ['the last namesake', 'b2'],
    ['the first namesake, holding the base slug', 'b1'],
    ['a station priced for both fuels', 'd1'],
  ])('bridges every URL that loses its page when %s disappears', (_label, goneId) => {
    const previousPaths = stationPaths(first);
    const next = refresh(first, before.filter((row) => row.id !== goneId));
    const pages = new Set(stationPaths(next));
    const bridges = generateFuelItalianStationAvailabilityBridges({ dataset: next as never });
    const lost = previousPaths.filter((pagePath) => !pages.has(pagePath));

    expect(lost.length).toBeGreaterThan(0);
    for (const pagePath of lost) {
      expect(bridges[pagePath], pagePath).toContain('<meta name="robots" content="noindex,follow">');
    }
    // A bridge never replaces an indexable page.
    expect(Object.keys(bridges).filter((pagePath) => pages.has(pagePath))).toEqual([]);
  });

  it('bridges the last station of a non-curated comune, whose city entry is gone', () => {
    const comune = { name: 'Comune Di Prova', province: 'VA', lat: 45.9, lng: 8.6 };
    const build = (previousDataset: unknown, current: Row[]) => {
      const italyByMunicipality = new Map([['Comune Di Prova:VA', current]]);
      return buildDataset({
        municipalities: [comune],
        italyExtractedAt: TODAY.toISOString().slice(0, 10),
        swissStations: [],
        italyByMunicipality,
        italyRouteMemory: italyRouteMemoryByMunicipality(previousDataset, italyByMunicipality),
        exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
      });
    };
    const listed = build(null, [rows[0]]);
    const previousPaths = stationPaths(listed);
    const bridges = generateFuelItalianStationAvailabilityBridges({ dataset: build(listed, []) as never });

    expect(previousPaths.length).toBeGreaterThan(0);
    expect(Object.keys(bridges).sort()).toEqual([...previousPaths].sort());
  });

  const FUELS_AND_LOCALES = [
    ['it', 'benzina'], ['en', 'benzina'], ['de', 'benzina'], ['fr', 'benzina'],
    ['it', 'diesel'], ['en', 'diesel'], ['de', 'diesel'], ['fr', 'diesel'],
  ] as const;
  // The two namesakes alone, A cheaper: the cut is sorted by price, so today A
  // holds the base slug and B the `-2` one.
  const stationA = { ...twin, id: 'a', priceEur: 1.901, dieselPriceEur: 1.801 };
  const stationB = { ...twin, id: 'b', priceEur: 1.902, dieselPriceEur: 1.802 };
  const stationC = { ...twin, id: 'c', priceEur: 1.903, dieselPriceEur: 1.803 };
  const SLUG = 'shell-viale-rosselli';
  const routeOf = (locale: 'it' | 'en' | 'de' | 'fr', fuel: 'benzina' | 'diesel', slug: string) =>
    buildFuelItalianStationPath(locale, fuel, 'como', slug);
  const emitted = (dataset: unknown) => ({
    pages: generateFuelItalianStationPages({ dataset: dataset as never, today: TODAY }),
    bridges: generateFuelItalianStationAvailabilityBridges({ dataset: dataset as never }),
  });

  it('keeps each namesake at its own URL through a retirement, a repeat refresh and a second retirement', () => {
    const both = refresh(null, [stationA, stationB]);
    for (const [locale, fuel] of FUELS_AND_LOCALES) {
      expect(emitted(both).pages[routeOf(locale, fuel, SLUG)]).toBeDefined();
      expect(emitted(both).pages[routeOf(locale, fuel, `${SLUG}-2`)]).toBeDefined();
    }

    const withoutA = refresh(both, [stationB]);
    const repeated = refresh(withoutA, [stationB]);
    expect(repeated.municipalities[0].italy).toEqual(withoutA.municipalities[0].italy);
    for (const dataset of [withoutA, repeated]) {
      const { pages, bridges } = emitted(dataset);
      for (const [locale, fuel] of FUELS_AND_LOCALES) {
        expect(pages[routeOf(locale, fuel, `${SLUG}-2`)], `${locale} ${fuel} B`).toBeDefined();
        expect(pages[routeOf(locale, fuel, SLUG)]).toBeUndefined();
        expect(bridges[routeOf(locale, fuel, SLUG)], `${locale} ${fuel} A`).toContain('noindex,follow');
        expect(bridges[routeOf(locale, fuel, `${SLUG}-2`)]).toBeUndefined();
      }
    }

    // B retires too and a third namesake opens: it takes neither remembered URL.
    const onlyC = refresh(repeated, [stationC]);
    const { pages, bridges } = emitted(onlyC);
    for (const [locale, fuel] of FUELS_AND_LOCALES) {
      expect(bridges[routeOf(locale, fuel, SLUG)]).toContain('noindex,follow');
      expect(bridges[routeOf(locale, fuel, `${SLUG}-2`)]).toContain('noindex,follow');
      expect(pages[routeOf(locale, fuel, `${SLUG}-3`)]).toBeDefined();
    }
    // A comes back to the URL it had.
    const returned = emitted(refresh(onlyC, [stationC, stationA])).pages;
    expect(returned[routeOf('it', 'benzina', SLUG)]).toBeDefined();
    expect(returned[routeOf('it', 'benzina', `${SLUG}-3`)]).toBeDefined();
  });

  it('keeps homonym comuni of different provinces apart, each with its own retired station', () => {
    const comuni = ['VA', 'CO'].map((province) => ({ name: 'Comune Di Prova', province, lat: 45.9, lng: 8.6 }));
    const build = (previousDataset: unknown, byProvince: Record<string, Row[]>) => {
      const italyByMunicipality = new Map(
        Object.entries(byProvince).map(([province, list]) => [`Comune Di Prova:${province}`, list]),
      );
      return buildDataset({
        municipalities: comuni,
        italyExtractedAt: TODAY.toISOString().slice(0, 10),
        swissStations: [],
        italyByMunicipality,
        italyRouteMemory: italyRouteMemoryByMunicipality(previousDataset, italyByMunicipality),
        exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
      });
    };
    // Two priced homonyms cannot coexist (`buildItalianCityEntries` throws), so
    // the two rows get there one after the other.
    const first = build(null, { VA: [rows[0]] });
    const second = build(first, { CO: [rows[1]] });
    const third = build(second, {});
    for (const dataset of [third, build(third, {})]) {
      const paths = Object.keys(generateFuelItalianStationAvailabilityBridges({ dataset: dataset as never }))
        .filter((pagePath) => pagePath.startsWith('/prezzi-benzina/italia/'));
      expect(paths.sort()).toEqual([
        '/prezzi-benzina/italia/comune-di-prova-co/stazioni/q8-via-varesina/',
        '/prezzi-benzina/italia/comune-di-prova/stazioni/eni-via-del-dos/',
      ]);
    }
  });

  it.each([['first'], ['last']])(
    'never assigns a row without province to a province-qualified homonym (row listed %s)',
    (position) => {
      const row = (province: string | undefined, id: string) => ({
        municipality: 'Comune Di Prova',
        province,
        italy: { stations: [], retiredStations: [{ id, brand: 'Q8', stationName: 'Prova', address: `Via ${id}` }] },
      });
      const qualified = [row('VA', 'Alfa'), row('CO', 'Beta')];
      const unknown = row(undefined, 'Gamma');
      const municipalities = position === 'first' ? [unknown, ...qualified] : [...qualified, unknown];
      const paths = Object.keys(generateFuelItalianStationAvailabilityBridges({ dataset: { municipalities } as never }))
        .filter((pagePath) => pagePath.startsWith('/prezzi-benzina/italia/'));
      expect(paths.sort()).toEqual([
        '/prezzi-benzina/italia/comune-di-prova-co/stazioni/q8-via-beta/',
        '/prezzi-benzina/italia/comune-di-prova/stazioni/q8-via-alfa/',
      ]);
    },
  );

  it('keeps the bridges of a comune that no row qualifies with a province', () => {
    const municipalities = [{
      municipality: 'Comune Di Prova',
      italy: { stations: [], retiredStations: [{ id: '3', brand: 'Q8', stationName: 'Prova', address: 'Via Gamma' }] },
    }];
    const paths = Object.keys(generateFuelItalianStationAvailabilityBridges({ dataset: { municipalities } as never }));
    expect(paths).toContain('/prezzi-benzina/italia/comune-di-prova/stazioni/q8-via-gamma/');
  });

  it('freezes the URLs a snapshot without route memory has, even when prices swap the namesakes', () => {
    const published = refresh(null, [stationA, stationB]);
    const legacy = structuredClone(published);
    delete (legacy.municipalities[0].italy as { stationRoutes?: unknown }).stationRoutes;
    // B is now cheaper: derived from the current order alone, it would take the base slug.
    const swapped = refresh(legacy, [{ ...stationB, priceEur: 1.5 }, stationA]);
    expect(swapped.municipalities[0].italy.stationRoutes).toEqual({ a: SLUG, b: `${SLUG}-2` });
    expect(swapped.municipalities[0].italy.stationRoutes).toEqual(published.municipalities[0].italy.stationRoutes);
  });

  it('keeps the route memory out of everything written to Firestore', () => {
    const dataset = refresh(refresh(null, before), [rows[0]]);
    expect(dataset.municipalities[0].italy.retiredStations?.length).toBeGreaterThan(0);
    expect(Object.keys(dataset.municipalities[0].italy.stationRoutes ?? {})).toHaveLength(before.length);
    // `summary` and `rankings` go to `fuelPrices/metadata` and embed station rows.
    const written = [buildItalyFirestoreDoc(dataset.municipalities), dataset.summary, dataset.rankings];
    expect(JSON.stringify(written)).not.toMatch(/stationRoutes|retiredStations/);
    expect(buildItalyFirestoreDoc(dataset.municipalities).municipalities[0].italy.stationCount).toBe(1);
  });

  it('publishes station id → page, which the SPA prefers over any slug it derives', () => {
    const manifest = buildItalianStationPagesManifest(
      [routeOf('it', 'benzina', `${SLUG}-2`), routeOf('en', 'benzina', `${SLUG}-2`)],
      [
        { station: { id: 'b' }, cityEntry: { slug: 'como' }, slug: `${SLUG}-2` },
        { station: { id: 'skipped' }, cityEntry: { slug: 'como' }, slug: 'not-written' },
      ],
    );
    expect(manifest).toEqual({ stations: [`como/${SLUG}-2`], byStationId: { b: `como/${SLUG}-2` } });

    const loaded = { pages: new Set([`como/${SLUG}`, `como/${SLUG}-2`]), byStationId: manifest.byStationId };
    // Firestore rows carry no memory, so B alone derives the base slug.
    const derived = { citySlug: 'como', stationSlug: SLUG };
    expect(resolveItalianStationRoute('b', derived, loaded)).toEqual({ citySlug: 'como', stationSlug: `${SLUG}-2` });
    expect(resolveItalianStationRoute('skipped', derived, loaded)).toBeNull();
    // A manifest published before `byStationId`, and no manifest at all.
    expect(resolveItalianStationRoute('b', derived, { ...loaded, byStationId: null })).toEqual(derived);
    expect(resolveItalianStationRoute('b', derived, { pages: new Set(), byStationId: null })).toBeNull();
    expect(resolveItalianStationRoute('b', derived, null)).toEqual(derived);
  });

  // The route rule runs on the JS twin (the generator is plain Node); the pages
  // published so far were slugged by the TS function.
  it.each([
    [{ brand: 'Q8', name: 'mezzanotte', address: 'VIA DI PROVA 17 21000 - PAESE DI PROVA VA' }],
    [{ brand: 'UNDEFINED', name: 'Stazione Prova', address: "Via dell'Esempio 12, 22100 Como" }],
    [{ brand: '', name: '', address: 'Corso Città Nuova 3A' }],
    [{ brand: undefined, name: undefined, address: undefined }],
  ])('slugs a station the same way as fuelDailyData', (station) => {
    expect(buildTwinStationSlug(station)).toBe(buildStationSlug(station));
  });

  it('remembers a retired station across later refreshes, as identity only, and forgets it on return', () => {
    const without = before.filter((row) => row.id !== 'd1');
    const second = refresh(first, without);
    const third = refresh(second, without);
    expect(third.municipalities[0].italy.retiredStations).toEqual([
      { id: 'd1', brand: 'Eni', stationName: 'Eni Como', address: 'Via del Dos 14, 22100 Como' },
    ]);
    expect(third.municipalities[0].italy.stationCount).toBe(without.length);
    expect(refresh(third, before).municipalities[0].italy).not.toHaveProperty('retiredStations');
  });
});

describe('diesel Italian-stations index — orphan contract', () => {
  const dieselLeaves: ItalianStationLeaf[] = [
    { citySlug: 'como', cityDisplay: 'Como', stationSlug: 'eni-via-del-dos', name: 'Eni Como', brand: 'Eni', address: 'Via del Dos 14, 22100 Como' },
    { citySlug: 'como', cityDisplay: 'Como', stationSlug: 'q8-via-varesina', name: 'Q8 Como', brand: 'Q8', address: 'Via Varesina 128, 22100 Como' },
  ];
  const pages = generateFuelIndexPages({
    today: TODAY,
    swissStations: [],
    italianStations: dieselLeaves, // benzina default (back-compat)
    italianStationsByFuel: { benzina: dieselLeaves, diesel: dieselLeaves },
  });

  it('emits the diesel Italian-stations index when diesel coverage exists', () => {
    expect(pages[buildFuelIndexPath('it', 'diesel', 'italianStations')]).toBeDefined();
  });

  it('links every diesel station leaf from its index (no orphans)', () => {
    const html = pages[buildFuelIndexPath('it', 'diesel', 'italianStations')]!;
    for (const leaf of dieselLeaves) {
      expect(countAnchors(html, `/italia/${leaf.citySlug}/stazioni/${leaf.stationSlug}/`)).toBeGreaterThanOrEqual(1);
    }
  });

  it('does NOT emit a diesel Italian-stations index when no diesel leaves are provided', () => {
    const benzinaOnly = generateFuelIndexPages({
      today: TODAY,
      swissStations: [],
      italianStations: dieselLeaves,
    });
    expect(benzinaOnly[buildFuelIndexPath('it', 'diesel', 'italianStations')]).toBeUndefined();
  });
});
