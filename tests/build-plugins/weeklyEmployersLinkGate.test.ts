/**
 * Task 6 — verifies `buildCompanyCityLinks` filters out sub-threshold pairs
 * before emitting any `<a href>` candidate.
 *
 * The helper is the shared gate used by sitemap, related-links, and footer
 * emission sites. If it ever lets a pair with active<3 through, the link
 * graph will start pointing at `/aziende-che-assumono/{city}/{company}/
 * settimana-corrente/` URLs that the page generator refuses to materialise,
 * recreating the "empty shell" SPA fallback that Phase 3 fixes.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_JOBS_PER_COMPANY_IN_CITY,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '../../build-plugins/weeklyEmployersData';
import {
  buildCompanyCityLinks,
  type CompanyCityLink,
} from '../../build-plugins/weeklyEmployersPlugin';

interface Pair {
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  employer: string;
  active: number;
}

function makePair(overrides: Partial<Pair> & { active: number }): Pair {
  return {
    city: overrides.city ?? 'lugano',
    companySlug: overrides.companySlug ?? 'acme-corp',
    employer: overrides.employer ?? 'Acme Corp',
    active: overrides.active,
  };
}

describe('buildCompanyCityLinks', () => {
  const locale: WeeklyEmployersLocale = 'it';

  it('returns no links when the pair list is empty', () => {
    expect(buildCompanyCityLinks([], locale)).toEqual([]);
  });

  it('drops pairs with fewer active jobs than MIN_JOBS_PER_COMPANY_IN_CITY', () => {
    const pairs: ReadonlyArray<Pair> = [
      makePair({ active: 0, companySlug: 'a' }),
      makePair({ active: 1, companySlug: 'b' }),
      makePair({ active: MIN_JOBS_PER_COMPANY_IN_CITY - 1, companySlug: 'c' }),
    ];
    expect(buildCompanyCityLinks(pairs, locale)).toEqual([]);
  });

  it('keeps pairs at or above the threshold', () => {
    const pairs: ReadonlyArray<Pair> = [
      makePair({
        active: MIN_JOBS_PER_COMPANY_IN_CITY,
        companySlug: 'exact',
        employer: 'ExactOrg',
        city: 'lugano',
      }),
      makePair({
        active: 10,
        companySlug: 'over',
        employer: 'OverOrg',
        city: 'chiasso',
      }),
    ];
    const links = buildCompanyCityLinks(pairs, locale);
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe('/aziende-che-assumono/lugano/exact/settimana-corrente/');
    expect(links[0].label).toBe('ExactOrg — Lugano');
    expect(links[1].href).toBe('/aziende-che-assumono/chiasso/over/settimana-corrente/');
    expect(links[1].label).toBe('OverOrg — Chiasso');
  });

  it('mixes gated and ungated pairs correctly', () => {
    const pairs: ReadonlyArray<Pair> = [
      makePair({ active: 1, companySlug: 'drop', employer: 'Drop', city: 'stabio' }),
      makePair({ active: 5, companySlug: 'keep', employer: 'Keep', city: 'mendrisio' }),
      makePair({ active: 2, companySlug: 'drop2', employer: 'Drop2', city: 'locarno' }),
      makePair({ active: 3, companySlug: 'keep2', employer: 'Keep2', city: 'bellinzona' }),
    ];
    const links: ReadonlyArray<CompanyCityLink> = buildCompanyCityLinks(pairs, locale);
    expect(links.map((l) => l.href)).toEqual([
      '/aziende-che-assumono/mendrisio/keep/settimana-corrente/',
      '/aziende-che-assumono/bellinzona/keep2/settimana-corrente/',
    ]);
  });

  it('emits locale-aware paths for non-IT locales', () => {
    const pair = makePair({
      active: 4,
      companySlug: 'globaltech',
      employer: 'GlobalTech',
      city: 'lugano',
    });
    expect(buildCompanyCityLinks([pair], 'en')[0].href).toBe(
      '/en/companies-hiring/lugano/globaltech/current-week/',
    );
    expect(buildCompanyCityLinks([pair], 'de')[0].href).toBe(
      '/de/unternehmen-einstellen/lugano/globaltech/aktuelle-woche/',
    );
    expect(buildCompanyCityLinks([pair], 'fr')[0].href).toBe(
      '/fr/entreprises-recrutent/lugano/globaltech/semaine-courante/',
    );
  });

  it('never emits a link for a pair whose active count sits just under the threshold', () => {
    const justUnder = MIN_JOBS_PER_COMPANY_IN_CITY - 1;
    const pairs: ReadonlyArray<Pair> = Array.from({ length: 10 }, (_, i) =>
      makePair({ active: justUnder, companySlug: `c${i}` }),
    );
    expect(buildCompanyCityLinks(pairs, locale)).toEqual([]);
  });
});
