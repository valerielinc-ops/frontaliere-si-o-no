import { describe, expect, it } from 'vitest';
import { syncItalianMasterSlug } from '../scripts/regenerate-slugs-by-locale.mjs';

describe('Italian master route synchronization', () => {
  it('preserves a replaced master route when the locale slot already has the old route', () => {
    const job = {
      slug: 'old-italian-route',
      slugByLocale: { it: 'old-italian-route' },
      previousSlugsByLocale: { it: ['old-italian-route'] },
    };

    expect(syncItalianMasterSlug(job, 'old-italian-route', 'pinned-italian-route')).toBe(true);
    expect(job.slug).toBe('pinned-italian-route');
    expect(job.previousSlugsByLocale.it).toEqual(['old-italian-route']);
  });

  it('preserves the fallback master route when a missing locale slot is pinned', () => {
    const job = {
      slug: 'fallback-master-route',
      slugByLocale: {},
    };

    expect(syncItalianMasterSlug(job, '', 'pinned-italian-route')).toBe(true);
    expect(job.slug).toBe('pinned-italian-route');
    expect(job.previousSlugsByLocale.it).toEqual(['fallback-master-route']);
  });
});
