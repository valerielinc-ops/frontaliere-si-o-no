/**
 * Shared canton-aware test fixtures.
 *
 * Use these helpers instead of inlining `canton: 'TI'` test data so tests stay
 * portable across the cathedral CH-wide expansion (P1, 2026-05-10) — i.e. so
 * a test that doesn't actually assert TI-specific behaviour can run on any of
 * the 26 Swiss cantons without leaking a hardcoded canton choice into the
 * fixture.
 *
 * Two contracts:
 *
 * 1. `makeJobFixture()` — returns a single Job-shaped object (the `Job` type
 *    in `services/jobsService.ts` is `Record<string, unknown>`, so the
 *    fixture is intentionally loose). Defaults to TI/Lugano so existing
 *    tests that swap a local `job()` factory for `makeJobFixture()` keep the
 *    same data shape.
 *
 * 2. `makeCrawlerJobsFixture()` — emits N jobs for a single crawler slug,
 *    auto-resolving city/canton/postalCode via the company HQ registry.
 *    Falls back to TI/Lugano if the slug is unknown.
 *
 * Tests that genuinely test canton-specific behaviour (e.g. "Bancastato is
 * in TI", "VS-canton landings emit Vallese in IT") MUST keep their hardcoded
 * canton assertions — the fixture is for canton-agnostic test data only.
 */

import {
  ALL_CANTON_CODES,
  COMPANY_HQ,
  SWISS_CANTONS,
  TARGET_CANTONS,
  // @ts-expect-error — .mjs import has no .d.ts; consumers test runtime values.
} from '@/scripts/lib/crawler-location-config.mjs';

/**
 * A reasonable spread of cantons for parametrised tests. Mixes the legacy
 * three (TI/GR/VS) with major Swiss employer hubs added by the cathedral
 * expansion (ZH/BE/BS/GE/VD).
 */
export const SAMPLE_CANTONS = ['TI', 'GR', 'VS', 'ZH', 'BE', 'BS', 'GE', 'VD'] as const;

export type SampleCanton = (typeof SAMPLE_CANTONS)[number];

/**
 * Default city per canton when a fixture caller doesn't pass one explicitly.
 * Picks the largest / most-likely-to-appear-in-job-data city per canton.
 * Anything not in this map falls back to the first alias from SWISS_CANTONS.
 */
const DEFAULT_CITY_BY_CANTON: Record<string, string> = {
  TI: 'Lugano',
  GR: 'Chur',
  VS: 'Sion',
  ZH: 'Zürich',
  BE: 'Bern',
  BS: 'Basel',
  GE: 'Genève',
  VD: 'Lausanne',
  AG: 'Aarau',
  LU: 'Luzern',
  SG: 'St. Gallen',
  TG: 'Frauenfeld',
  SO: 'Solothurn',
  FR: 'Fribourg',
  NE: 'Neuchâtel',
  JU: 'Delémont',
  SH: 'Schaffhausen',
  ZG: 'Zug',
  SZ: 'Schwyz',
  GL: 'Glarus',
  NW: 'Stans',
  OW: 'Sarnen',
  UR: 'Altdorf',
  AR: 'Herisau',
  AI: 'Appenzell',
  BL: 'Liestal',
};

const DEFAULT_POSTAL_CODE_BY_CANTON: Record<string, string> = {
  TI: '6900',
  GR: '7000',
  VS: '1950',
  ZH: '8001',
  BE: '3001',
  BS: '4001',
  GE: '1200',
  VD: '1003',
  AG: '5000',
  LU: '6003',
  SG: '9000',
  TG: '8500',
  SO: '4500',
  FR: '1700',
  NE: '2000',
  JU: '2800',
  SH: '8200',
  ZG: '6300',
  SZ: '6430',
  GL: '8750',
  NW: '6370',
  OW: '6060',
  UR: '6460',
  AR: '9100',
  AI: '9050',
  BL: '4410',
};

interface CantonDefaults {
  city: string;
  canton: string;
  postalCode: string;
  addressRegion: string;
}

function resolveCantonDefaults(canton: string): CantonDefaults {
  const code = String(canton || '').toUpperCase().trim() || 'TI';
  if (!SWISS_CANTONS[code]) {
    // Unknown code → fall back to TI rather than throw, to keep test ergonomics.
    return resolveCantonDefaults('TI');
  }
  const city =
    DEFAULT_CITY_BY_CANTON[code] ||
    // First alias is usually the canonical city/canton name.
    SWISS_CANTONS[code].names[0]
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
  const postalCode = DEFAULT_POSTAL_CODE_BY_CANTON[code] || '0000';
  return { city, canton: code, postalCode, addressRegion: code };
}

export interface JobFixtureOptions {
  /** 2-letter canton code; defaults to 'TI'. */
  canton?: string;
  /** City name; defaults to canton-appropriate default (e.g. Lugano for TI). */
  city?: string;
  /** Postal code; defaults to canton-appropriate default. */
  postalCode?: string;
  /** Job title; defaults to 'Software Engineer'. */
  title?: string;
  /** Company display name. */
  company?: string;
  /** Crawler slug — when set, overrides canton/city/postalCode via COMPANY_HQ. */
  companyKey?: string;
  /** Job slug; defaults to 'job-id'. */
  slug?: string;
  /** ISO date string; defaults to '2026-03-09'. */
  postedDate?: string;
  /** ISO datetime; defaults to '2026-03-09T08:00:00.000+01:00'. */
  crawledAt?: string;
  /** Job description body. */
  description?: string;
  /** Free-form override map merged last (wins over named options). */
  [extra: string]: unknown;
}

/**
 * Build a single canton-parametrised job fixture.
 *
 * Default ergonomics match the legacy ad-hoc `job()` factories scattered
 * across the test suite: TI/Lugano, generic title, postedDate 2026-03-09.
 */
export function makeJobFixture(options: JobFixtureOptions = {}): Record<string, unknown> {
  const {
    canton: rawCanton,
    city: rawCity,
    postalCode: rawPostalCode,
    title,
    company,
    companyKey,
    slug,
    postedDate,
    crawledAt,
    description,
    ...rest
  } = options;

  // If a companyKey is given and matches a known HQ, use those defaults.
  const hq = companyKey && COMPANY_HQ[companyKey] ? COMPANY_HQ[companyKey] : null;
  const cantonDefaults = hq
    ? { city: hq.city, canton: hq.canton, postalCode: hq.postalCode, addressRegion: hq.addressRegion }
    : resolveCantonDefaults(rawCanton ?? 'TI');

  const canton = rawCanton ?? cantonDefaults.canton;
  const city = rawCity ?? cantonDefaults.city;
  const postalCode = rawPostalCode ?? cantonDefaults.postalCode;

  return {
    id: String(slug || 'job-id'),
    slug: String(slug || 'job-id'),
    url: `https://example.com/${slug || 'job-id'}`,
    title: String(title || 'Software Engineer'),
    company: String(company || 'Test Company'),
    companyKey: String(companyKey || 'test-company'),
    location: city,
    city,
    canton,
    postalCode,
    addressRegion: canton,
    description: String(description || 'Descrizione base.'),
    requirements: [] as string[],
    postedDate: String(postedDate || '2026-03-09'),
    crawledAt: String(crawledAt || '2026-03-09T08:00:00.000+01:00'),
    ...rest,
  };
}

/**
 * Emit `count` jobs for a single crawler slug, with stable slugs and
 * canton/city/postalCode auto-resolved via COMPANY_HQ.
 *
 * Useful for tests that exercise per-crawler dedup / canton-filter logic
 * without hand-rolling a 50-line array literal.
 */
export function makeCrawlerJobsFixture(
  crawlerSlug: string,
  count: number,
  options: JobFixtureOptions = {},
): Record<string, unknown>[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const baseSlug = options.slug || crawlerSlug;
  return Array.from({ length: count }, (_, idx) =>
    makeJobFixture({
      ...options,
      companyKey: crawlerSlug,
      slug: `${baseSlug}-${idx + 1}`,
    }),
  );
}

/**
 * Re-export canton catalogue helpers so tests don't have to dig into the
 * .mjs path themselves.
 */
export { ALL_CANTON_CODES, SWISS_CANTONS, TARGET_CANTONS };

/**
 * Convenience: total number of recognised Swiss cantons (always 26).
 * Use this in assertions instead of hardcoding `3` (legacy TI/GR/VS) or
 * `26` (post-cathedral).
 */
export const SWISS_CANTON_COUNT = ALL_CANTON_CODES.length;
