/**
 * Fuel `<title>` budget — observer for the `title-too-long` family of the
 * Bing full-tree crawl (issue 10120).
 *
 * Two fuel generators shipped titles above the crawler limit because
 * `clampSiteSuffix` only drops the "| Frontaliere Ticino" suffix and never
 * truncates the base:
 *   - Italian city hubs used the full H1 when "H1 (date)" overflowed, so a
 *     long comune ("Bardello con Malgesso e Bregano") produced 67-79 chars;
 *   - the DE Italian-stations index copy was 69 chars, 71 with "— Seite N".
 *
 * The limit is imported from the crawler (never duplicated) and the city
 * titles are measured with the crawler's own `classifyDocument`, so this test
 * goes red exactly when the Bing report would raise `title-too-long` for a
 * fuel page: a new long comune, a new index copy, a new page suffix.
 */

import { describe, expect, it } from 'vitest';
import { generateFuelItalianCityPages } from '../../build-plugins/fuelDailyPagesPlugin';
import {
  FUEL_INDEX_SLUG,
  indexTitleFor,
  type FuelIndexKind,
} from '../../build-plugins/fuelStationIndexPages';
import { FUEL_DAILY_LOCALES, FUEL_TYPES } from '../../build-plugins/fuelDailyData';
import { TITLE_MAX_CHARS, classifyDocument } from '../../scripts/seo/bing-site-explorer-crawl.mjs';

function stations(prefix: string, idBase: number, city: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${idBase + i}`,
    stationName: `${prefix} ${city} ${i + 1}`,
    brand: prefix,
    address: `Via Roma ${i + 1}, ${city}`,
    priceEur: 1.699 + i / 100,
    dieselPriceEur: 1.759 + i / 100,
  }));
}

// Same shape as tests/fuel-daily-italian-cities.test.ts, plus the two long
// comuni that sat at the top of the 2026-10-03 finding list.
const LONG_COMUNI = ['Bardello con Malgesso e Bregano', 'Cavaria con Premezzo'];
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
    ...LONG_COMUNI.map((municipality, i) => ({
      municipality,
      province: 'VA',
      italy: { stations: stations(i === 0 ? 'Eni' : 'Ip', 100 + i * 10, municipality, 3) },
    })),
  ],
};

describe('fuel <title> budget — Italian city hubs', () => {
  const pages = generateFuelItalianCityPages({
    dataset: DATASET,
    today: new Date('2026-04-20T06:00:00.000Z'),
  });
  const longPaths = Object.keys(pages).filter((p) =>
    /bardello-con-malgesso-e-bregano|cavaria-con-premezzo/.test(p),
  );

  it('emits every long-comune page (4 locales × 2 fuels each)', () => {
    expect(longPaths.length).toBeGreaterThanOrEqual(
      LONG_COMUNI.length * FUEL_DAILY_LOCALES.length * FUEL_TYPES.length,
    );
  });

  it.each(Object.keys(pages))('%s keeps <title> within the crawler limit', (path) => {
    const result = classifyDocument({
      url: `https://frontaliereticino.ch${path}`,
      status: 200,
      contentType: 'text/html',
      html: pages[path],
    });
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.title.length, result.title).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(result.findings.map((f: { code: string }) => f.code)).not.toContain('title-too-long');
  });

  it('cuts only the <title>: the visible H1 keeps the full comune name', () => {
    for (const path of longPaths) {
      const h1 = pages[path].match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '';
      expect(h1.toLowerCase()).toMatch(/bardello con malgesso e bregano|cavaria con premezzo/);
    }
  });

  it('cuts the <title> on a whole clause, never inside the " — qualifier"', () => {
    for (const path of longPaths) {
      const html = pages[path];
      const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
      const h1 = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
      const head = title
        .replace(/ \| Frontaliere Ticino$/, '')
        .replace(/ \(\d{4}-\d{2}-\d{2}\)$/, '');
      expect(h1.startsWith(head), `${title} vs ${h1}`).toBe(true);
      // What the cut dropped starts at a clause boundary (" — …" or the
      // differentiation tag " (…)"), not mid-qualifier ("… più economiche").
      expect(h1.slice(head.length), `${title} vs ${h1}`).toMatch(/^$|^ [—(]/);
    }
  });
});

describe('fuel <title> budget — station and city indexes', () => {
  const PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const checked: string[] = [];
  for (const kind of Object.keys(FUEL_INDEX_SLUG) as FuelIndexKind[]) {
    for (const locale of FUEL_DAILY_LOCALES) {
      for (const fuel of FUEL_TYPES) {
        for (const page of PAGES) {
          checked.push(`${kind}|${locale}|${fuel}|${page}`);
        }
      }
    }
  }

  it('covers every kind × locale × fuel × page (anti vacuous green)', () => {
    expect(checked.length).toBeGreaterThanOrEqual(3 * 4 * 2 * 6);
    expect(checked.length).toBe(
      Object.keys(FUEL_INDEX_SLUG).length * FUEL_DAILY_LOCALES.length * FUEL_TYPES.length * PAGES.length,
    );
  });

  it.each(checked)('%s keeps <title> within the crawler limit', (key) => {
    const [kind, locale, fuel, page] = key.split('|');
    const title = indexTitleFor(
      kind as FuelIndexKind,
      locale as (typeof FUEL_DAILY_LOCALES)[number],
      fuel as (typeof FUEL_TYPES)[number],
      Number(page),
    );
    expect(title.length).toBeGreaterThan(0);
    expect(title.length, title).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});
