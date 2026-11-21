// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildExpiredEntry,
  mergeExpiredRouteEvidence,
} from '../scripts/lib/expired-jobs-archive.mjs';

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
});
