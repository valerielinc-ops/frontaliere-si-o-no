/**
 * #4602 — reconcileGhostExpired title+company matching key collapsed
 * different real postings that share a generic title at a high-volume,
 * multi-site employer (Coop, Migros, ...) onto whichever active job happened
 * to be "first" in iteration order, merging the expired job's slugs onto the
 * WRONG job's previousSlugs (669 misattributed slugs across 24 slices,
 * 441 in coop-ticino.json alone). Location is now part of the match key.
 */
import { describe, it, expect } from 'vitest';
import { reconcileGhostExpired } from '../scripts/assemble-jobs-dataset.mjs';

describe('reconcileGhostExpired — title+company+location match key', () => {
  it('does NOT merge an expired job onto an active job at a DIFFERENT location sharing the same generic title+company', () => {
    const activeJobs = [
      {
        title: 'Verkäufer:in Food',
        company: 'Coop Genossenschaft',
        location: 'Bätterkinden, Bern',
        slug: 'verkaeufer-in-food-baetterkinden',
        slugByLocale: { de: 'verkaeufer-in-food-baetterkinden' },
      },
    ];
    const expiredJobs = [
      {
        title: 'Verkäufer:in Food',
        company: 'Coop Genossenschaft',
        location: 'Thun, Bern',
        slug: 'verkaeufer-in-food-thun-old',
        slugByLocale: { de: 'verkaeufer-in-food-thun-old' },
      },
    ];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(ghostCount).toBe(0);
    expect(mergedSlugs).toBe(0);
    expect(cleanedExpired).toHaveLength(1);
    expect(activeJobs[0].previousSlugs || []).not.toContain('verkaeufer-in-food-thun-old');
  });

  it('still merges an expired job onto the SAME posting (same title+company+location, slug changed by retranslation)', () => {
    const activeJobs = [
      {
        title: 'Verkäufer:in Food',
        company: 'Coop Genossenschaft',
        location: 'Bätterkinden, Bern',
        slug: 'verkaeufer-in-food-baetterkinden-new',
        slugByLocale: { de: 'verkaeufer-in-food-baetterkinden-new' },
      },
    ];
    const expiredJobs = [
      {
        title: 'Verkäufer:in Food',
        company: 'Coop Genossenschaft',
        location: 'Bätterkinden, Bern',
        slug: 'verkaeufer-in-food-baetterkinden-old',
        slugByLocale: { de: 'verkaeufer-in-food-baetterkinden-old' },
      },
    ];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(ghostCount).toBe(1);
    expect(mergedSlugs).toBe(1);
    expect(cleanedExpired).toHaveLength(0);
    expect(activeJobs[0].previousSlugs).toContain('verkaeufer-in-food-baetterkinden-old');
  });
});
