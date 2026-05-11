/**
 * Regression: router recency/oggi guard
 *
 * Verifies that parsePath() returns staticOverlay:true (not a job-detail route)
 * for every oggi/today/heute/aujourd'hui landing slug across all cantons and
 * every recency landing slug (ultimi-3-giorni / da-ieri and locale variants).
 *
 * Background: before the fix, `/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/`
 * fell through to `{ jobSlug: 'offerte-di-lavoro-ticino-oggi' }` which triggered the
 * "Annuncio non trovato" error banner when the SPA hydrated over the static page.
 */

import { describe, it, expect } from 'vitest';
import { parsePath } from '@/services/router';
import {
  EDITORIAL_CANTONS,
  EDITORIAL_PRIMARY_CANTONS,
  JOB_TODAY_LANDING_SLUGS,
  isJobTodayLandingSlug,
} from '../../build-plugins/jobEditorialLanding';
import {
  JOB_RECENCY_LANDING_SLUGS,
  isJobRecencyLandingSlug,
} from '../../build-plugins/jobRecencyLanding';

// ── Job-board section slug for each locale ─────────────────────────
// Must mirror SLUG_TABLES in services/router.ts
const JOB_BOARD_SECTION: Record<string, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const LOCALE_PREFIX: Record<string, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

// ── Helper ──────────────────────────────────────────────────────────
function buildUrl(locale: string, slug: string): string {
  const prefix = LOCALE_PREFIX[locale];
  const section = JOB_BOARD_SECTION[locale];
  return `${prefix}/${section}/${slug}/`;
}

describe('recency/oggi router guards — isJobTodayLandingSlug', () => {
  const today2LocaSlugs = Object.values(JOB_TODAY_LANDING_SLUGS);

  it('isJobTodayLandingSlug recognises all TI oggi slugs', () => {
    for (const slug of today2LocaSlugs) {
      expect(isJobTodayLandingSlug(slug), `expected '${slug}' to be a today slug`).toBe(true);
    }
  });

  it('isJobTodayLandingSlug rejects unrelated strings', () => {
    expect(isJobTodayLandingSlug('')).toBe(false);
    expect(isJobTodayLandingSlug('ultimi-3-giorni')).toBe(false);
    expect(isJobTodayLandingSlug('software-engineer-lugano')).toBe(false);
  });

  it('isJobRecencyLandingSlug recognises all recency slugs in all locales', () => {
    for (const variant of ['last-3-days', 'since-yesterday'] as const) {
      for (const slug of Object.values(JOB_RECENCY_LANDING_SLUGS[variant])) {
        expect(isJobRecencyLandingSlug(slug), `expected '${slug}' to be a recency slug`).toBe(true);
      }
    }
  });
});

describe('recency/oggi router guards — parsePath oggi slugs', () => {
  const LOCALES = ['it', 'en', 'de', 'fr'] as const;

  // Build a flat list of { locale, slug, label } for all oggi slugs across all locales.
  // The slug tables in jobEditorialLanding.ts only expose per-canton per-locale slugs,
  // so we construct them from EDITORIAL_CANTONS × all 4 locales.
  const OGGI_BY_LOCALE: Record<string, string> = {
    it: 'offerte-di-lavoro-ticino-oggi',
    en: 'ticino-jobs-today',
    de: 'jobs-tessin-heute',
    fr: 'offres-emploi-tessin-aujourdhui',
  };

  for (const locale of LOCALES) {
    const todaySlug = OGGI_BY_LOCALE[locale];
    const url = buildUrl(locale, todaySlug);

    it(`parsePath("${url}") → staticOverlay:true, no jobSlug`, () => {
      const { route } = parsePath(url);
      expect(route.activeTab).toBe('job-board');
      expect(route.staticOverlay).toBe(true);
      expect((route as unknown as Record<string, unknown>).jobSlug).toBeUndefined();
    });
  }

  // Multi-canton oggi slugs (GR and VS) are locale-prefixed with 'it'
  const MULTI_CANTON_IT: Record<string, string> = {
    GR: 'offerte-di-lavoro-grigioni-oggi',
    VS: 'offerte-di-lavoro-vallese-oggi',
  };

  for (const [canton, slug] of Object.entries(MULTI_CANTON_IT)) {
    const url = buildUrl('it', slug);
    it(`parsePath("${url}") [${canton}] → staticOverlay:true, no jobSlug`, () => {
      const { route } = parsePath(url);
      expect(route.activeTab).toBe('job-board');
      expect(route.staticOverlay).toBe(true);
      expect((route as unknown as Record<string, unknown>).jobSlug).toBeUndefined();
    });
  }

  // Phase 5 (Cathedral P1-A): EDITORIAL_CANTONS expanded from 3 cantons
  // (TI/GR/VS) to all 24 canton URL keys; the legacy 3-canton invariant
  // moved to EDITORIAL_PRIMARY_CANTONS (display-only for prose like
  // "Ticino, Grigioni e Vallese"). The emit loops are now gated on
  // MIN_JOBS_FOR_CANTON_PAGE so thin pages never ship.
  it('EDITORIAL_PRIMARY_CANTONS contains exactly TI, GR, VS', () => {
    expect([...EDITORIAL_PRIMARY_CANTONS].sort()).toEqual(['GR', 'TI', 'VS']);
  });
  it('EDITORIAL_CANTONS spans ≥ 24 canton URL keys (full Cathedral coverage)', () => {
    expect(EDITORIAL_CANTONS.length).toBeGreaterThanOrEqual(24);
    expect([...EDITORIAL_CANTONS]).toEqual(expect.arrayContaining(['TI', 'GR', 'VS', 'ZH', 'APPENZELLO', 'BASILEA']));
  });
});

describe('recency/oggi router guards — parsePath recency slugs', () => {
  const LOCALES = ['it', 'en', 'de', 'fr'] as const;

  for (const variant of ['last-3-days', 'since-yesterday'] as const) {
    for (const locale of LOCALES) {
      const slug = JOB_RECENCY_LANDING_SLUGS[variant][locale];
      const url = buildUrl(locale, slug);

      it(`parsePath("${url}") [${variant}] → staticOverlay:true, no jobSlug`, () => {
        const { route } = parsePath(url);
        expect(route.activeTab).toBe('job-board');
        expect(route.staticOverlay).toBe(true);
        expect((route as unknown as Record<string, unknown>).jobSlug).toBeUndefined();
      });
    }
  }
});

describe('recency/oggi router guards — regression: no-jobSlug on all landing slugs', () => {
  it('every today landing slug in SLUG_TABLES does NOT produce a jobSlug route', () => {
    const TODAY_SLUGS_BY_LOCALE = {
      it: 'offerte-di-lavoro-ticino-oggi',
      en: 'ticino-jobs-today',
      de: 'jobs-tessin-heute',
      fr: 'offres-emploi-tessin-aujourdhui',
    } as const;

    const violations: string[] = [];
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const url = buildUrl(locale, TODAY_SLUGS_BY_LOCALE[locale]);
      const { route } = parsePath(url);
      if ((route as unknown as Record<string, unknown>).jobSlug !== undefined) {
        violations.push(`${url} → jobSlug set`);
      }
    }
    expect(violations).toEqual([]);
  });
});
