// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildExpiredEntry,
  localeRouteKeys,
  mergeExpiredRouteEvidence,
  transferSlugHistory,
} from '../scripts/lib/expired-jobs-archive.mjs';
import { LEGACY_PREV_SLUGS_CAP } from '../scripts/lib/dedicated-crawler-common.mjs';
import { resolveExpiredRouteCanton } from '../scripts/lib/expired-route-canton.mjs';

describe('expired route evidence', () => {
  it('persists canton in new archive records and carries old locale routes into history', () => {
    const archived = buildExpiredEntry({
      slug: 'canonical',
      canton: 'ZH',
      location: 'Zürich',
      slugByLocale: { it: 'canonical', de: 'current-de' },
    });
    expect(archived.canton).toBe('ZH');

    const survivor: Record<string, any> = {
      slug: 'canonical',
      location: '',
      slugByLocale: { it: 'canonical', de: 'current-de' },
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      location: 'Zürich',
      slugByLocale: { it: 'canonical', de: 'old-de' },
    };

    expect(mergeExpiredRouteEvidence(survivor, historical)).toBe(true);
    expect(survivor.canton).toBe('ZH');
    expect(survivor.location).toBe('Zürich');
    expect(survivor.slugByLocale).toEqual({ it: 'canonical', de: 'current-de' });
    expect(survivor.previousSlugsByLocale?.de).toEqual(['old-de']);
  });

  it('does not overwrite a newer explicit canton context', () => {
    const survivor: Record<string, any> = { slug: 'canonical', canton: 'TI' };
    const historical: Record<string, any> = { slug: 'canonical', canton: 'ZH', slugByLocale: { de: 'old-de' } };

    mergeExpiredRouteEvidence(survivor, historical);

    expect(survivor.canton).toBe('TI');
    expect(survivor.previousSlugsByLocale?.de).toEqual(['old-de']);
  });

  it('keeps the historical canton on a transferred route', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      canton: 'TI',
      slugByLocale: { en: 'new' },
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      slugByLocale: { en: 'old' },
    };

    mergeExpiredRouteEvidence(survivor, historical);

    expect(survivor.previousSlugsByLocale?.en).toEqual(['old']);
    expect(survivor.previousSlugCantonByLocale?.en?.old).toBe('ZH');
    expect(resolveExpiredRouteCanton(survivor, 'en', 'old')).toBe('ZH');
    expect(resolveExpiredRouteCanton(survivor, 'en', 'new')).toBe('TI');
  });

  it('keeps a deep flat legacy route union above the active cap, with canton evidence and a fixed point', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      canton: 'TI',
      slugByLocale: { it: 'canonical' },
      previousSlugs: Array.from({ length: 79 }, (_, index) => `survivor-history-${index}`),
      previousSlugsByLocale: {},
    };
    const historicalRoutes = Array.from({ length: 12 }, (_, index) => `historical-flat-${index}`);
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      slugByLocale: { it: 'canonical' },
      previousSlugs: historicalRoutes,
      previousSlugsByLocale: {},
      previousSlugCantonByLocale: { en: { [historicalRoutes[0]]: 'BE' } },
    };
    const expectedRoutes = new Set([
      ...localeRouteKeys(survivor),
      ...localeRouteKeys(historical),
    ]);

    expect(survivor.previousSlugs.length + historical.previousSlugs.length).toBe(91);
    expect(mergeExpiredRouteEvidence(survivor, historical)).toBe(true);
    expect(survivor.previousSlugs).toHaveLength(91);
    const mergedRoutes = localeRouteKeys(survivor);
    expect([...expectedRoutes].filter((route) => !mergedRoutes.has(route))).toEqual([]);
    expect(resolveExpiredRouteCanton(survivor, 'en', historicalRoutes[0])).toBe('BE');
    expect(resolveExpiredRouteCanton(survivor, 'de', historicalRoutes[0])).toBe('ZH');

    const routeBearingFields = (record: Record<string, any>) => ({
      slugByLocale: record.slugByLocale,
      previousSlugs: record.previousSlugs,
      previousSlugsByLocale: record.previousSlugsByLocale,
      previousSlugCantonByLocale: record.previousSlugCantonByLocale,
    });
    const settled = JSON.stringify(routeBearingFields(survivor));
    expect(mergeExpiredRouteEvidence(survivor, historical)).toBe(false);
    expect(JSON.stringify(routeBearingFields(survivor))).toBe(settled);
    expect(localeRouteKeys(survivor)).toEqual(mergedRoutes);
  });

  it('counts route-only history enrichment as backfill work that must be written', () => {
    const backfill = readFileSync(
      new URL('../scripts/backfill-expired-from-history.mjs', import.meta.url),
      'utf8',
    );

    expect(backfill).toContain(
      'if (routeEvidenceChanged || sourceIdentityChanged) recoveredFromHistory++;',
    );
  });

  it('keeps deep locale-attributed archive routes in their original buckets', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      slugByLocale: { it: 'canonical' },
      previousSlugsByLocale: {
        de: Array.from({ length: 21 }, (_, index) => `survivor-de-${index}`),
      },
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      slugByLocale: { it: 'canonical', en: 'historical-en' },
      previousSlugsByLocale: {
        en: Array.from({ length: 22 }, (_, index) => `historical-en-${index}`),
        fr: ['historical-fr'],
      },
      previousSlugCantonByLocale: { en: { 'historical-en-0': 'BE' } },
    };
    const expectedRoutes = new Set([
      ...localeRouteKeys(survivor),
      ...localeRouteKeys(historical),
    ]);

    mergeExpiredRouteEvidence(survivor, historical);

    expect(survivor.previousSlugsByLocale.de).toHaveLength(21);
    expect(survivor.previousSlugsByLocale.en).toEqual([
      'historical-en',
      ...Array.from({ length: 22 }, (_, index) => `historical-en-${index}`),
    ]);
    expect(survivor.previousSlugsByLocale.fr).toEqual(['historical-fr']);
    expect([...expectedRoutes].filter((route) => !localeRouteKeys(survivor).has(route))).toEqual([]);
    expect(resolveExpiredRouteCanton(survivor, 'en', 'historical-en-0')).toBe('BE');
  });

  it('widens a flat route already attributed by the survivor without erasing its canton', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      canton: 'TI',
      slugByLocale: { it: 'canonical' },
      previousSlugsByLocale: { en: ['shared-flat-route'] },
      previousSlugCantonByLocale: { en: { 'shared-flat-route': 'BE' } },
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      slugByLocale: { it: 'canonical' },
      previousSlugs: ['shared-flat-route'],
      previousSlugsByLocale: {},
    };
    const expectedRoutes = new Set([
      ...localeRouteKeys(survivor),
      ...localeRouteKeys(historical),
    ]);

    mergeExpiredRouteEvidence(survivor, historical);

    const mergedRoutes = localeRouteKeys(survivor);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(mergedRoutes.has(`${locale}:shared-flat-route`)).toBe(true);
    }
    expect([...expectedRoutes].filter((route) => !mergedRoutes.has(route))).toEqual([]);
    expect(survivor.previousSlugsByLocale.en).toContain('shared-flat-route');
    expect(survivor.previousSlugs).toContain('shared-flat-route');
    expect(resolveExpiredRouteCanton(survivor, 'en', 'shared-flat-route')).toBe('BE');
    expect(resolveExpiredRouteCanton(survivor, 'de', 'shared-flat-route')).toBe('ZH');
  });

  it('keeps an existing flat route under every locale when new history attributes it', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      slugByLocale: { it: 'canonical' },
      previousSlugs: ['shared-flat-route'],
      previousSlugsByLocale: {},
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      canton: 'ZH',
      slugByLocale: { it: 'canonical' },
      previousSlugsByLocale: { en: ['shared-flat-route'] },
    };
    const expectedRoutes = new Set([
      ...localeRouteKeys(survivor),
      ...localeRouteKeys(historical),
    ]);

    mergeExpiredRouteEvidence(survivor, historical);

    const mergedRoutes = localeRouteKeys(survivor);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(mergedRoutes.has(`${locale}:shared-flat-route`)).toBe(true);
    }
    expect([...expectedRoutes].filter((route) => !mergedRoutes.has(route))).toEqual([]);
    expect(survivor.previousSlugs).toContain('shared-flat-route');
    expect(resolveExpiredRouteCanton(survivor, 'en', 'shared-flat-route')).toBe('ZH');
    expect(resolveExpiredRouteCanton(survivor, 'de', 'shared-flat-route')).toBe('ZH');
  });

  it('fails closed before mutating malformed survivor history', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      previousSlugsByLocale: { de: 'not-an-array' },
    };
    const historical: Record<string, any> = { canton: 'ZH', slugByLocale: { de: 'old-de' } };

    expect(() => mergeExpiredRouteEvidence(survivor, historical)).toThrow(/previousSlugsByLocale/);
    expect(survivor.canton).toBeUndefined();
  });

  it('preserves a full legacy route union without dropping the historical route', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      location: 'Lugano',
      previousSlugs: Array.from({ length: LEGACY_PREV_SLUGS_CAP }, (_, index) => `legacy-${index}`),
      previousSlugsByLocale: {},
    };
    const historical: Record<string, any> = {
      slug: 'canonical',
      previousSlugs: ['historical-only-route'],
    };
    expect(mergeExpiredRouteEvidence(survivor, historical)).toBe(true);
    expect(survivor.previousSlugs).toHaveLength(LEGACY_PREV_SLUGS_CAP + 1);
    expect(survivor.previousSlugs).toContain('historical-only-route');
  });
});

describe('transferSlugHistory flat-only attribution', () => {
  it.each([false, true])('transfers a flat slug whose only bucket is unsupported (preserveAll=%s)', (preserveAllExpiredRoutes) => {
    const survivor: Record<string, unknown> = { slug: 'ruolo-superstite' };
    transferSlugHistory(survivor, {
      slug: 'ruolo-rimosso',
      previousSlugs: ['ruolo-storico'],
      previousSlugsByLocale: { es: ['ruolo-storico'] },
    }, 'unsupported-locale-test', { preserveAllExpiredRoutes });

    const routes = localeRouteKeys(survivor);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect([...routes]).toContain(`${locale}:ruolo-storico`);
    }
  });
});
