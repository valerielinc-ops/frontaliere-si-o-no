// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  collapseDuplicateRouteEntries,
  localeRouteKeys,
} from '../scripts/lib/expired-jobs-archive.mjs';

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Shape of the Rittmeyer archive written by crawler group 22 at 1c37bfda6c2d
 * (2026-11-09). Both records were archived in the same run (same expiredAt):
 *   - the real "Sales Project Engineer (a) Ticino" posting, which names its
 *     Onlyfy source and serves the indexed Rittmeyer routes;
 *   - an identity-less record carrying the Vitrea slugs of an old archive
 *     entry, which shares one Rittmeyer history route with it.
 * The slug tie-break (`apprendistato-…` < `sales-project-…`) made the
 * identity-less record the survivor: the posting collapsed onto Vitrea slugs,
 * and the re-listed active row b3aaa0626c66 inherited them from the archive.
 */
function rittmeyerCase(expiredAt: string) {
  const sharedHistory = 'sales-project-engineer-a-ticino-rittmeyer-ag-camorino';
  const salesProjectEngineer = {
    slug: 'sales-project-engineer-a-ticino-rittmeyer-ag-tessin',
    title: 'Sales Project Engineer (a) Ticino',
    company: 'Rittmeyer AG',
    companyKey: 'rittmeyer-ag',
    location: 'Camorino',
    expiredAt,
    slugByLocale: {
      it: 'sales-project-engineer-a-ticino-rittmeyer-ag-tessin',
      en: sharedHistory,
      de: 'verkaufsprojektingenieur-in-tessin-rittmeyer-ag-camorino',
      fr: 'ingenieur-commercial-projets-tessin-rittmeyer-ag-tessin',
    },
    previousSlugs: ['sales-project-ingegnere-a-ticino-rittmeyer-ag-camorino', sharedHistory],
    previousSlugsByLocale: { it: ['sales-project-ingegnere-a-ticino-rittmeyer-ag-camorino', sharedHistory] },
    sourceIdentity: 'url:https://brugg.onlyfy.jobs/en/job/4it6c5xx4ivuhudv7e6kk1oyh232efn?career_page_search=page%3d2',
    firstSeenAt: '2026-04-13T22:18:55.902Z',
  };
  const contaminated = {
    slug: 'apprendistato-come-fachfrau-fachmann-gesundheit-e-cfc-vitrea-gesundheit-tschugg',
    title: 'Sales Project Engineer (a) Ticino',
    company: 'Rittmeyer AG',
    companyKey: 'rittmeyer-ag',
    location: 'Camorino',
    expiredAt,
    slugByLocale: {
      it: 'apprendistato-come-fachfrau-fachmann-gesundheit-e-cfc-vitrea-gesundheit-tschugg',
      en: 'apprenticeship-as-a-specialist-health-e-efz-vitrea-gesundheit-tschugg',
      de: 'lehrstelle-als-fachfrau-fachmann-gesundheit-e-efz-vitrea-gesundheit-tschugg',
      fr: 'apprentissage-en-tant-que-specialiste-de-la-sante-e-efz-vitrea-gesundheit-tschugg',
    },
    previousSlugs: [sharedHistory],
    previousSlugsByLocale: { it: [sharedHistory] },
  };
  return { salesProjectEngineer, contaminated, sharedHistory };
}

describe('collapseDuplicateRouteEntries identity guard', () => {
  it('never lets an identity-less record take over a named posting (Rittmeyer/Vitrea, 1c37bfda6c2d)', () => {
    const { salesProjectEngineer, contaminated } = rittmeyerCase(daysAgo(4));

    const result = collapseDuplicateRouteEntries(
      structuredClone([salesProjectEngineer, contaminated]),
      { source: 'test/rittmeyer-vitrea' },
    );

    expect(result.collapsed).toBe(0);
    expect(result.entries).toHaveLength(2);
    const named = result.entries.find((entry) => entry.sourceIdentity === salesProjectEngineer.sourceIdentity);
    // The posting keeps its own Rittmeyer slugs: the archive record a re-listed
    // row is reconciled against by source identity still points at them.
    expect(named?.slug).toBe(salesProjectEngineer.slug);
    expect(named?.slugByLocale).toEqual(salesProjectEngineer.slugByLocale);
    expect(Object.values(named?.slugByLocale ?? {}).some((slug) => /vitrea/.test(String(slug)))).toBe(false);
    // Nothing is lost: every route either record served is still served.
    const before = new Set([...localeRouteKeys(salesProjectEngineer), ...localeRouteKeys(contaminated)]);
    const after = new Set(result.entries.flatMap((entry) => [...localeRouteKeys(entry)]));
    expect([...before].filter((route) => !after.has(route))).toEqual([]);
    // The identity-less record stays verbatim and gains no source identity.
    const unnamed = result.entries.find((entry) => entry.slug === contaminated.slug);
    expect(unnamed?.sourceIdentity).toBeUndefined();
    expect(unnamed?.sourceIdentityHistory).toBeUndefined();
  });

  it('is independent of input order and reaches a fixed point', () => {
    const { salesProjectEngineer, contaminated } = rittmeyerCase(daysAgo(4));
    const forward = collapseDuplicateRouteEntries(structuredClone([salesProjectEngineer, contaminated]));
    const reversed = collapseDuplicateRouteEntries(structuredClone([contaminated, salesProjectEngineer]));
    expect(reversed.entries).toEqual(forward.entries);
    const again = collapseDuplicateRouteEntries(structuredClone(forward.entries));
    expect(again.entries).toEqual(forward.entries);
    expect(again.collapsed).toBe(0);
  });

  it('never merges two companies, even when both name a source and share every route', () => {
    const { salesProjectEngineer } = rittmeyerCase(daysAgo(4));
    const foreign = {
      ...structuredClone(salesProjectEngineer),
      company: 'Vitrea Gesundheit',
      companyKey: 'vitrea-gesundheit',
      sourceIdentity: 'url:https://vamed-ag-ch.onlyfy.jobs/de/job/det0au4rpxboufulztv2yld1pgkard2',
      expiredAt: daysAgo(1),
    };

    const result = collapseDuplicateRouteEntries(structuredClone([salesProjectEngineer, foreign]));

    expect(result.collapsed).toBe(0);
    expect(result.entries.map((entry) => entry.companyKey).sort()).toEqual(['rittmeyer-ag', 'vitrea-gesundheit']);
    for (const entry of result.entries) {
      expect(entry.slugByLocale).toEqual(salesProjectEngineer.slugByLocale);
      expect(entry.sourceIdentityHistory).toBeUndefined();
    }
  });

  it('still collapses two named records of the same posting history', () => {
    const { salesProjectEngineer, sharedHistory } = rittmeyerCase(daysAgo(4));
    const relisted = {
      ...structuredClone(salesProjectEngineer),
      slug: 'sales-project-engineer-a-ticino-rittmeyer-ag-camorino-2',
      slugByLocale: { it: 'sales-project-engineer-a-ticino-rittmeyer-ag-camorino-2' },
      previousSlugs: [sharedHistory],
      previousSlugsByLocale: { en: [sharedHistory] },
      expiredAt: daysAgo(1),
    };

    const result = collapseDuplicateRouteEntries(structuredClone([salesProjectEngineer, relisted]));

    expect(result.collapsed).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(localeRouteKeys(result.entries[0]).has(`it:${salesProjectEngineer.slug}`)).toBe(true);
  });
});
