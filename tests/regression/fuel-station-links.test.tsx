/**
 * Regression: fuel station rows must have links to their canonical pages.
 *
 * Bug #6 — build plugin (fuelDailyPagesPlugin):
 *   computeZonePrice was returning minStations without brand/slug, so the
 *   stationsHtml block rendered plain <li> elements with no anchor.
 *   Fix: slug is now derived via buildStationSlug and stored on each minStation
 *   entry; stationsHtml wraps each <li> in <a href="/prezzi-diesel/{zone}/stazioni/{slug}/">.
 *
 * Bug #5 — React component (FuelPriceStats):
 *   Swiss station rows inside DetailSection had no link to their per-station page.
 *   Fix: buildSwissStationSlug + zoneFromAddress exported from fuelPricesService
 *   derive the correct URL; each row is conditionally wrapped in <a>.
 */

import { describe, it, expect } from 'vitest';
import { buildStationSlug, buildFuelStationPath, buildFuelItalianCityPath, FUEL_ITALIAN_CITIES, slugify } from '../../build-plugins/fuelDailyData';
import { buildSwissStationSlug, zoneFromAddress } from '../../services/fuelPricesService';

// ── B6: slug derivation matches build-plugin logic ──────────────────────────

describe('B6 — buildStationSlug (fuelDailyData)', () => {
  it('derives slug from brand + street (house number stripped)', () => {
    const slug = buildStationSlug({ brand: 'Eni', name: 'Eni Chiasso', address: 'Via Compolongo 12, 6830 Chiasso' });
    expect(slug).toBe('eni-via-compolongo');
  });

  it('falls back to name when brand is missing', () => {
    const slug = buildStationSlug({ brand: null, name: 'Agrola Bellinzona', address: 'Via San Gottardo 65, 6500 Bellinzona' });
    expect(slug).toBe('agrola-via-san-gottardo');
  });

  it('treats UNDEFINED brand as missing', () => {
    const slug = buildStationSlug({ brand: 'UNDEFINED', name: 'Shell Lugano', address: 'Via Zurigo 10, 6900 Lugano' });
    expect(slug).toBe('shell-via-zurigo');
  });

  it('produces a non-empty slug for all Ticino-zone address patterns', () => {
    const cases = [
      { brand: 'BP', address: 'Via Cantonale 3, 6850 Mendrisio' },
      { brand: 'Migrol', address: 'Via Lugano 5, 6710 Biasca' },
      { brand: 'Socar', address: 'Via Locarno 8, 6600 Locarno' },
    ];
    for (const c of cases) {
      expect(buildStationSlug(c).length).toBeGreaterThan(0);
    }
  });
});

describe('B6 — buildFuelStationPath (fuelDailyData)', () => {
  it('builds the correct Italian-locale per-station path', () => {
    const path = buildFuelStationPath('it', 'diesel', 'chiasso', 'eni-via-compolongo');
    expect(path).toBe('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/');
  });

  it('builds the correct English-locale per-station path', () => {
    const path = buildFuelStationPath('en', 'diesel', 'lugano', 'agrola-via-san-gottardo');
    // EN diesel section slug is "diesel-price-switzerland" (SEO-optimised for GSC queries)
    expect(path).toBe('/en/diesel-price-switzerland/lugano/stations/agrola-via-san-gottardo/');
  });

  it('links diesel and benzina station pages separately', () => {
    const diesel = buildFuelStationPath('it', 'diesel', 'bellinzona', 'eni-via-san-gottardo');
    const benzina = buildFuelStationPath('it', 'benzina', 'bellinzona', 'eni-via-san-gottardo');
    expect(diesel).toContain('/prezzi-diesel/');
    expect(benzina).toContain('/prezzi-benzina/');
    expect(diesel).not.toBe(benzina);
  });
});

describe('B6 — slugify round-trips', () => {
  it('strips accents (è → e)', () => {
    expect(slugify('Caffè Via')).toBe('caffe-via');
  });

  it('collapses consecutive special chars into a single dash', () => {
    expect(slugify('Via  Foo--Bar')).toBe('via-foo-bar');
  });

  it('returns empty string for null/undefined', () => {
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
  });
});

// ── B5: browser-side helpers in fuelPricesService ───────────────────────────

describe('B5 — buildSwissStationSlug (fuelPricesService)', () => {
  it('produces the same slug as the build-plugin for standard input', () => {
    const opts = { brand: 'Agrola', name: 'Agrola Bellinzona', address: 'Via San Gottardo 65, 6500 Bellinzona' };
    expect(buildSwissStationSlug(opts)).toBe(buildStationSlug(opts));
  });

  it('strips diacritics from brand names', () => {
    const slug = buildSwissStationSlug({ brand: 'Cafè', address: 'Via Foo 1, 6900 Lugano' });
    expect(slug).toMatch(/^cafe-/);
  });

  it('falls back to "stazione" when no brand/name/address are provided', () => {
    expect(buildSwissStationSlug({})).toBe('stazione');
  });
});

describe('B5 — zoneFromAddress (fuelPricesService)', () => {
  it('returns "chiasso" for Chiasso addresses', () => {
    expect(zoneFromAddress('Via Compolongo 12, 6830 Chiasso')).toBe('chiasso');
  });

  it('returns "lugano" for Lugano addresses', () => {
    expect(zoneFromAddress('Via Zurigo 10, 6900 Lugano')).toBe('lugano');
  });

  it('returns "bellinzona" for Bellinzona addresses', () => {
    expect(zoneFromAddress('Via San Gottardo 65, 6500 Bellinzona')).toBe('bellinzona');
  });

  it('returns "locarno" for Locarno addresses', () => {
    expect(zoneFromAddress('Via Locarno 1, 6600 Locarno')).toBe('locarno');
  });

  it('returns null for Biasca addresses (biasca is not a Ticino zone)', () => {
    // Biasca is north of the 5 canonical zones — no per-station page exists
    expect(zoneFromAddress('Via Lugano 5, 6710 Biasca')).toBeNull();
  });

  it('does NOT match "lugano" when it appears only in the street name, not the city', () => {
    // "Via Lugano 5, 6710 Biasca" → city = "biasca" (not in map) → null
    expect(zoneFromAddress('Via Lugano 5, 6710 Biasca')).toBeNull();
  });

  it('returns "mendrisio" for Mendrisio addresses', () => {
    expect(zoneFromAddress('Via Cantonale, 6850 Mendrisio')).toBe('mendrisio');
  });

  it('returns null for addresses outside the 5 Ticino zones', () => {
    expect(zoneFromAddress('Hauptstrasse 1, 8001 Zürich')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(zoneFromAddress(null)).toBeNull();
    expect(zoneFromAddress(undefined)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(zoneFromAddress('VIA ZURIGO 10, 6900 LUGANO')).toBe('lugano');
  });
});

// ── B5 + B6: link construction sanity check ─────────────────────────────────

describe('station deep-link URL construction (B5 + B6)', () => {
  it('builds a valid deep-link for an Eni station in Chiasso', () => {
    const brand = 'Eni';
    const name = 'Eni Chiasso';
    const address = 'Via Compolongo 12, 6830 Chiasso';
    const slug = buildSwissStationSlug({ brand, name, address });
    const zone = zoneFromAddress(address);
    expect(zone).not.toBeNull();
    const href = `/prezzi-diesel/${zone}/stazioni/${slug}/`;
    expect(href).toBe('/prezzi-diesel/chiasso/stazioni/eni-via-compolongo/');
  });

  it('returns no link for a station outside Ticino', () => {
    const address = 'Bahnhofstrasse 1, 8001 Zürich';
    const zone = zoneFromAddress(address);
    expect(zone).toBeNull();
  });
});

// ── Italian city fallback: station cards link to the city hub page ──────────

describe('italianCityHref fallback (stats page)', () => {
  it('resolves Como to its Italian-city hub path', () => {
    const entry = FUEL_ITALIAN_CITIES.find((c) => c.matchKey === 'como');
    expect(entry).toBeDefined();
    const href = buildFuelItalianCityPath('it', 'diesel', entry!.slug);
    expect(href).toBe('/prezzi-diesel/italia/como/oggi/');
  });

  it('resolves accented city names (Cantù → cantu)', () => {
    const entry = FUEL_ITALIAN_CITIES.find((c) => c.matchKey === 'cantù');
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe('cantu');
  });

  it('has no entry for off-catalog municipalities (Gera Lario)', () => {
    const entry = FUEL_ITALIAN_CITIES.find((c) => c.matchKey === 'gera lario');
    expect(entry).toBeUndefined();
  });
});
