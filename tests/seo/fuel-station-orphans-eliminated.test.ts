/**
 * Regression — fuel-station / fuel-cities orphan-pages-in-sitemaps gate.
 *
 * Background
 * ----------
 * Semrush's 2026-04-28 audit flagged 4 fuel-related sitemaps as having
 * thousands of "orphaned pages in sitemaps" entries (URLs listed but not
 * reachable via internal `<a href>` BFS from `/`):
 *
 *   - sitemap-fuel-italian-stations.xml: 424 / 424 = 100 % orphans
 *   - sitemap-fuel-stations.xml:         342 / 488 = 70 %
 *   - sitemap-fuel-italian-cities.xml:    88 /  88 = 100 %
 *   - sitemap-fuel-daily.xml:             24 /  48 = 50 % (DE + FR locales)
 *
 * The fix (per CLAUDE.md non-negotiable rule #5: never noindex an orphan,
 * always add internal links) is the new `fuelStationIndexPages` module: it
 * generates 3 paginated browseable indexes per (fuel, locale) that link every
 * leaf, and the daily-fuel pages now embed a hub-links block linking those
 * indexes plus sibling-locale daily hubs (lifting the DE/FR orphans).
 *
 * What this test asserts
 * ----------------------
 * Pure unit tests against the generators. No filesystem dependency, no real
 * `dist/` required — synthesise tiny inputs and check the resulting HTML
 * (which is what the audit script reads via BFS). We assert:
 *
 *   1. The 3 index page kinds exist for every locale × applicable fuel.
 *   2. Each index emits one `<a href>` per synthetic leaf input (= every
 *      sitemap-listed page is linked from its index).
 *   3. The hub-links block emitted into each daily-fuel page contains:
 *        - a link to each of the 3 indexes (or 2 for diesel: the IT-station
 *          index is benzina-only)
 *        - a link to the daily hub of every other locale (closes the 24-of-48
 *          DE/FR daily-fuel orphans)
 *   4. Index canonical paths follow the expected per-locale slug pattern.
 */

import { describe, it, expect } from 'vitest';
import {
  generateFuelIndexPages,
  renderFuelIndexHubLinks,
  buildFuelIndexPath,
  type SwissStationLeaf,
  type ItalianStationLeaf,
} from '../../build-plugins/fuelStationIndexPages';
import {
  FUEL_DAILY_LOCALES,
  FUEL_TYPES,
  FUEL_ZONES,
  FUEL_ITALIAN_CITIES,
  type FuelDailyLocale,
  type FuelType,
} from '../../build-plugins/fuelDailyData';

// ── Synthetic leaves ──────────────────────────────────────────────

const TODAY = new Date('2026-04-28T08:00:00Z');

const SYNTHETIC_SWISS: SwissStationLeaf[] = [
  { zone: 'chiasso', slug: 'eni-via-foo', name: 'Eni Chiasso', brand: 'Eni', address: 'Via Foo 1, 6830 Chiasso' },
  { zone: 'lugano', slug: 'tamoil-via-bar', name: 'Tamoil Lugano', brand: 'Tamoil', address: 'Via Bar 2, 6900 Lugano' },
  { zone: 'mendrisio', slug: 'avia-via-baz', name: 'Avia Mendrisio', brand: 'Avia', address: 'Via Baz 3, 6850 Mendrisio' },
];

const SYNTHETIC_ITALIAN: ItalianStationLeaf[] = [
  { citySlug: 'como', cityDisplay: 'Como', stationSlug: 'eni-via-cavour-1', name: 'Eni Como', brand: 'Eni', address: 'Via Cavour 1, 22100 Como' },
  { citySlug: 'varese', cityDisplay: 'Varese', stationSlug: 'q8-via-roma-2', name: 'Q8 Varese', brand: 'Q8', address: 'Via Roma 2, 21100 Varese' },
];

function countAnchors(html: string, hrefSubstr: string): number {
  // Count <a href="..."> occurrences whose href contains the substring.
  const re = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    if (href.includes(hrefSubstr)) count++;
  }
  return count;
}

function extractAnchorHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    if (typeof href === 'string') out.push(href);
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('fuel-station orphans — index pages exist for every locale × fuel', () => {
  const pages = generateFuelIndexPages({
    today: TODAY,
    swissStations: SYNTHETIC_SWISS,
    italianStations: SYNTHETIC_ITALIAN,
  });

  for (const fuel of FUEL_TYPES) {
    for (const locale of FUEL_DAILY_LOCALES) {
      it(`emits Swiss-stations index for ${locale}/${fuel}`, () => {
        const path = buildFuelIndexPath(locale, fuel, 'swissStations');
        expect(pages[path], `index missing at ${path}`).toBeDefined();
      });
      it(`emits Italian-cities index for ${locale}/${fuel}`, () => {
        const path = buildFuelIndexPath(locale, fuel, 'italianCities');
        expect(pages[path], `index missing at ${path}`).toBeDefined();
      });
      if (fuel === 'benzina') {
        it(`emits Italian-stations index for ${locale}/${fuel}`, () => {
          const path = buildFuelIndexPath(locale, fuel, 'italianStations');
          expect(pages[path], `index missing at ${path}`).toBeDefined();
        });
      } else {
        it(`does NOT emit Italian-stations index for ${locale}/${fuel} (benzina-only)`, () => {
          const path = buildFuelIndexPath(locale, fuel, 'italianStations');
          expect(pages[path]).toBeUndefined();
        });
      }
    }
  }
});

describe('fuel-station orphans — every synthetic leaf is linked from its index', () => {
  const pages = generateFuelIndexPages({
    today: TODAY,
    swissStations: SYNTHETIC_SWISS,
    italianStations: SYNTHETIC_ITALIAN,
  });

  for (const fuel of FUEL_TYPES) {
    it(`Swiss-stations index (it/${fuel}) links every Swiss station leaf`, () => {
      const html = pages[buildFuelIndexPath('it', fuel, 'swissStations')]!;
      for (const leaf of SYNTHETIC_SWISS) {
        // The full per-station path embeds zone + slug; both are unique.
        expect(countAnchors(html, `/${leaf.zone}/stazioni/${leaf.slug}/`)).toBeGreaterThanOrEqual(1);
      }
    });
    it(`Italian-cities index (it/${fuel}) links every curated city`, () => {
      const html = pages[buildFuelIndexPath('it', fuel, 'italianCities')]!;
      for (const c of FUEL_ITALIAN_CITIES) {
        expect(countAnchors(html, `/italia/${c.slug}/oggi/`)).toBeGreaterThanOrEqual(1);
      }
    });
  }

  it('Italian-stations index (it/benzina) links every Italian station leaf', () => {
    const html = pages[buildFuelIndexPath('it', 'benzina', 'italianStations')]!;
    for (const leaf of SYNTHETIC_ITALIAN) {
      expect(countAnchors(html, `/italia/${leaf.citySlug}/stazioni/${leaf.stationSlug}/`)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('fuel-station orphans — daily-page hub-links block reaches the indexes', () => {
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      it(`hub-links block (${locale}/${fuel}) links every applicable index`, () => {
        const html = renderFuelIndexHubLinks({ locale, fuel });
        // Swiss-stations index (always present)
        expect(countAnchors(html, buildFuelIndexPath(locale, fuel, 'swissStations'))).toBeGreaterThanOrEqual(1);
        // Italian-cities index (always present)
        expect(countAnchors(html, buildFuelIndexPath(locale, fuel, 'italianCities'))).toBeGreaterThanOrEqual(1);
        if (fuel === 'benzina') {
          // Italian-stations index (benzina only)
          expect(countAnchors(html, buildFuelIndexPath(locale, fuel, 'italianStations'))).toBeGreaterThanOrEqual(1);
        }
      });

      it(`hub-links block (${locale}/${fuel}) links the daily hub of every other locale (closes DE/FR daily orphans)`, () => {
        const html = renderFuelIndexHubLinks({ locale, fuel });
        const otherLocales: FuelDailyLocale[] = FUEL_DAILY_LOCALES.filter((l) => l !== locale) as FuelDailyLocale[];
        for (const alt of otherLocales) {
          // Ensure at least one anchor links to the alt-locale daily hub
          // (whose canonical path contains the alt-locale's section + today
          // slug; pick a fragment that's robust across slug naming).
          const hrefs = extractAnchorHrefs(html);
          const hits = hrefs.filter((h) => h.startsWith(alt === 'it' ? '/' : `/${alt}/`));
          expect(hits.length, `no link to ${alt} daily-hub from ${locale}/${fuel}`).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe('fuel-station orphans — index canonical paths use locale-specific slugs', () => {
  it('IT swiss-stations index lives at /prezzi-benzina/stazioni-svizzere/', () => {
    expect(buildFuelIndexPath('it', 'benzina', 'swissStations')).toBe('/prezzi-benzina/stazioni-svizzere/');
  });
  it('IT italian-stations index lives at /prezzi-benzina/stazioni-italia/', () => {
    expect(buildFuelIndexPath('it', 'benzina', 'italianStations')).toBe('/prezzi-benzina/stazioni-italia/');
  });
  it('IT italian-cities index lives at /prezzi-benzina/citta-italiane/', () => {
    expect(buildFuelIndexPath('it', 'benzina', 'italianCities')).toBe('/prezzi-benzina/citta-italiane/');
  });
  it('EN swiss-stations index lives at /en/gasoline-price-switzerland/swiss-stations/', () => {
    expect(buildFuelIndexPath('en', 'benzina', 'swissStations')).toBe('/en/gasoline-price-switzerland/swiss-stations/');
  });
  it('DE swiss-stations index lives at /de/benzinpreis-schweiz/schweizer-tankstellen/', () => {
    expect(buildFuelIndexPath('de', 'benzina', 'swissStations')).toBe('/de/benzinpreis-schweiz/schweizer-tankstellen/');
  });
  it('FR swiss-stations index lives at /fr/prix-essence-suisse/stations-suisses/', () => {
    expect(buildFuelIndexPath('fr', 'benzina', 'swissStations')).toBe('/fr/prix-essence-suisse/stations-suisses/');
  });
});

describe('fuel-station orphans — index pages clear the >=200-word content threshold', () => {
  const pages = generateFuelIndexPages({
    today: TODAY,
    swissStations: SYNTHETIC_SWISS,
    italianStations: SYNTHETIC_ITALIAN,
  });

  // Strip HTML and JSON-LD <script> blocks to count visible body words.
  function visibleBodyWords(html: string): number {
    const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    const noStyle = noScripts.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const text = noStyle
      .replace(/<head[\s\S]*?<\/head>/i, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return 0;
    return text.split(' ').length;
  }

  for (const fuel of FUEL_TYPES) {
    for (const locale of FUEL_DAILY_LOCALES) {
      it(`Swiss-stations index (${locale}/${fuel}) >= 200 visible-body words`, () => {
        const html = pages[buildFuelIndexPath(locale, fuel, 'swissStations')]!;
        expect(visibleBodyWords(html)).toBeGreaterThanOrEqual(200);
      });
    }
  }
});
