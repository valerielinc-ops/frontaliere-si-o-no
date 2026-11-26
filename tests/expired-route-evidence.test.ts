// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildExpiredEntry,
  mergeExpiredRouteEvidence,
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

  it('fails closed before mutating malformed survivor history', () => {
    const survivor: Record<string, any> = {
      slug: 'canonical',
      previousSlugsByLocale: { de: 'not-an-array' },
    };
    const historical: Record<string, any> = { canton: 'ZH', slugByLocale: { de: 'old-de' } };

    expect(() => mergeExpiredRouteEvidence(survivor, historical)).toThrow(/previousSlugsByLocale/);
    expect(survivor.canton).toBeUndefined();
  });

  it('leaves a deep survivor untouched when the legacy route cap refuses a merge', () => {
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
    const before = structuredClone(survivor);

    expect(mergeExpiredRouteEvidence(survivor, historical)).toBe(false);
    expect(survivor).toEqual(before);
  });
});
