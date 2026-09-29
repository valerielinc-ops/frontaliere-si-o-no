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
        slugByLocale: {
          de: 'verkaeufer-in-food-baetterkinden-new',
          en: 'verkaeufer-in-food-baetterkinden',
        },
      },
    ];
    const expiredJobs = [
      {
        title: 'Verkäufer:in Food',
        company: 'Coop Genossenschaft',
        location: 'Bätterkinden, Bern',
        slug: 'verkaeufer-in-food-baetterkinden-old',
        slugByLocale: {
          de: 'verkaeufer-in-food-baetterkinden-old',
          en: 'verkaeufer-in-food-baetterkinden',
        },
      },
    ];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(ghostCount).toBe(1);
    expect(mergedSlugs).toBe(1);
    expect(cleanedExpired).toHaveLength(0);
    expect(activeJobs[0].previousSlugs).toContain('verkaeufer-in-food-baetterkinden-old');
  });

  it('merges onto the overlapping slug owner when active jobs share the same match key', () => {
    const shared = {
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
    };
    const activeJobs = [
      {
        ...shared,
        slugByLocale: { it: 'store-manager-zurich-a' },
      },
      {
        ...shared,
        slugByLocale: { it: 'store-manager-zurich-b' },
      },
    ];
    const expiredJobs = [{
      url: 'https://example.test/store-manager-zurich-legacy',
      ...shared,
      slugByLocale: {
        it: 'store-manager-zurich-legacy',
        de: 'store-manager-zurich-b',
      },
    }];

    const { ghostCount, mergedSlugs, cleanedExpired } = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(ghostCount).toBe(1);
    expect(mergedSlugs).toBe(1);
    expect(cleanedExpired).toHaveLength(0);
    expect(activeJobs[0].previousSlugs || []).not.toContain('store-manager-zurich-legacy');
    expect(activeJobs[1].previousSlugs).toContain('store-manager-zurich-legacy');
  });

  it('does not let a foreign locale slug authorize a locale-only fallback', () => {
    const activeJobs = [
      {
        title: 'Store Manager',
        company: 'Rituals Cosmetics',
        location: 'Zürich',
        slugByLocale: { de: 'store-manager-zurich' },
      },
      {
        title: 'Different title',
        company: 'Different company',
        location: 'Lugano',
        slugByLocale: { de: 'foreign-owner-slug' },
      },
    ];
    const expiredJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics',
      location: 'Zürich',
      slugByLocale: { de: 'foreign-owner-slug' },
    }];

    const result = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(result.ghostCount).toBe(0);
    expect(result.mergedSlugs).toBe(0);
    expect(result.cleanedExpired).toEqual(expiredJobs);
    expect(activeJobs[0].previousSlugs || []).not.toContain('foreign-owner-slug');
  });

  it('does not coerce non-string locale values into ghost evidence', () => {
    const activeJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics',
      location: 'Zürich',
      slugByLocale: { de: {}, fr: 'active-slug' },
    }];
    const expiredJobs = [{
      url: 'https://example.test/expired',
      title: 'Store Manager',
      company: 'Rituals Cosmetics',
      location: 'Zürich',
      slugByLocale: { de: {}, fr: 'expired-slug' },
    }];

    const result = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(result.ghostCount).toBe(0);
    expect(result.cleanedExpired).toEqual(expiredJobs);
  });

  it('retains a distinct URL when two expired records share a top-level slug', () => {
    const activeJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
      slug: 'collision',
      slugByLocale: { it: 'collision' },
    }];
    const expiredJobs = [
      {
        url: 'https://example.test/first',
        title: 'Store Manager',
        company: 'Rituals Cosmetics Switzerland',
        location: 'Zürich',
        slug: 'collision',
        slugByLocale: { it: 'collision' },
      },
      {
        url: 'https://example.test/second',
        title: 'Store Manager',
        company: 'Rituals Cosmetics Switzerland',
        location: 'Zürich',
        slug: 'collision',
        slugByLocale: { it: 'different-slug' },
      },
    ];

    const { ghostCount, cleanedExpired } = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(ghostCount).toBe(1);
    expect(cleanedExpired).toEqual([expiredJobs[1]]);
  });

  it('uses a top-level slug as overlap evidence when locale slugs are absent', () => {
    const activeJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
      slug: 'store-manager-zurich',
    }];
    const expiredJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
      slug: 'store-manager-zurich',
    }];

    const result = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(result.ghostCount).toBe(1);
    expect(result.cleanedExpired).toEqual([]);
  });

  it('does not remove an expired record without a stable slug identity', () => {
    const activeJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
    }];
    const expiredJobs = [{
      title: 'Store Manager',
      company: 'Rituals Cosmetics Switzerland',
      location: 'Zürich',
      description: 'legacy record',
    }];

    const result = reconcileGhostExpired(activeJobs, expiredJobs);

    expect(result.ghostCount).toBe(0);
    expect(result.cleanedExpired).toEqual(expiredJobs);
  });
});
