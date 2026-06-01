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
 * Stations without a Gasolio price must be excluded from diesel pages but
 * still appear on benzina pages.
 */

import { describe, expect, it } from 'vitest';
import {
  generateFuelItalianCityPages,
  generateFuelItalianStationPages,
} from '../build-plugins/fuelDailyPagesPlugin';
import {
  generateFuelIndexPages,
  buildFuelIndexPath,
  type ItalianStationLeaf,
} from '../build-plugins/fuelStationIndexPages';

const TODAY = new Date('2026-05-18T06:00:00Z');

// Como is in the curated FUEL_ITALIAN_CITIES list. Two stations carry diesel,
// one is benzina-only (must be dropped from diesel pages).
const DATASET = {
  generatedAt: TODAY.toISOString(),
  municipalities: [
    {
      municipality: 'Como',
      province: 'CO',
      italy: {
        stations: [
          { id: 'd1', brand: 'Eni', stationName: 'Eni Como', address: 'Via del Dos 14, 22100 Como', priceEur: 1.919, dieselPriceEur: 1.829, isSelf: true, lat: 45.81, lng: 9.08 },
          { id: 'd2', brand: 'Q8', stationName: 'Q8 Como', address: 'Via Varesina 128, 22100 Como', priceEur: 1.939, dieselPriceEur: 1.799, isSelf: true, lat: 45.80, lng: 9.07 },
          { id: 'b1', brand: 'Shell', stationName: 'Shell Como', address: 'Viale Rosselli 19, 22100 Como', priceEur: 1.959, dieselPriceEur: null, isSelf: true, lat: 45.79, lng: 9.06 },
        ],
      },
      swiss: {
        // `cheapestStation` is ranked by benzina (sp95). Its diesel price
        // (2.327) is NOT the cheapest diesel nearby — ch2 has diesel 1.950.
        // The verdict must use the true diesel minimum.
        cheapestStation: { id: 'ch1', name: 'Silo', brand: 'Migrol', address: 'Chiasso', sp95PriceEur: 2.009, dieselPriceEur: 2.327 },
        nearbyStations: [
          { id: 'ch1', name: 'Silo', brand: 'Migrol', address: 'Chiasso', sp95PriceEur: 2.009, dieselPriceEur: 2.327 },
          { id: 'ch2', name: 'Coop', brand: 'Coop', address: 'Maslianico', sp95PriceEur: 2.099, dieselPriceEur: 1.950 },
        ],
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

  it('excludes the benzina-only station from the diesel page but keeps it on benzina', () => {
    const diesel = pages['/prezzi-diesel/italia/como/oggi/']!;
    const benzina = pages['/prezzi-benzina/italia/como/oggi/']!;
    expect(diesel).not.toContain('Shell Como');
    expect(benzina).toContain('Shell Como');
  });

  it('renders the cross-border verdict banner using the true CH diesel minimum', () => {
    const html = pages['/prezzi-diesel/italia/como/oggi/']!;
    expect(html).toContain('s-itVerdict');
    // Italy is cheaper for diesel (IT 1.799 vs true CH diesel min 1.950).
    expect(html).toMatch(/conviene fare il pieno in Italia/);
    // Saving uses the true diesel min (|1.950−1.799|×50 = 7.55), NOT the
    // diesel price of the benzina-cheapest station (|2.327−1.799|×50 = 26.40).
    expect(html).toContain('7,55');
    expect(html).not.toContain('26,40');
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
