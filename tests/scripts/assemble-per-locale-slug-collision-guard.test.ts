// @vitest-environment node
/**
 * Unit tests for the per-locale slug collision guard exported by
 * scripts/assemble-jobs-dataset.mjs.
 *
 * Regression source: incident 2026-05-26 (PR #614). A hallucinated EN title
 * for job axpo-group-3b351c9ebffe produced an EN slug that exactly matched
 * sibling job axpo-group-b16db3a9513c's IT base slug, blew up
 * audit:sitemap-canonicals, and blocked Deploy to GitHub Pages. The guard
 * runs after the IT-base-slug dedup, detects cross-job locale-slug
 * collisions, drops the offending translation, and flags
 * needsRetranslation so the next crawler run regenerates a fresh slug.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — assemble-jobs-dataset.mjs has no .d.ts companion
import { applyPerLocaleSlugCollisionGuard } from '../../scripts/assemble-jobs-dataset.mjs';

describe('applyPerLocaleSlugCollisionGuard', () => {
  it('drops EN slug + title when it collides with another job IT base in same canton', () => {
    const jobA = {
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'ingegnere-di-calcolo-meccanica-strutturale-m-f-d-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-di-calcolo-meccanica-strutturale-m-f-d-acme-corp-leibstadt',
        en: 'projektmanager-m-w-d-acme-corp-leibstadt',
        de: 'berechnungsingenieur-strukturmechanik-m-w-d-acme-corp-leibstadt',
        fr: 'projektmanager-m-m-j-acme-corp-leibstadt',
      },
      titleByLocale: {
        it: 'Ingegnere di calcolo',
        en: 'Projektmanager (m/w/d)',
        de: 'Berechnungsingenieur',
        fr: 'Projektmanager (m/m/j)',
      },
    };
    const jobB = {
      url: 'https://employer.example/jobs/b',
      canton: 'AG',
      slug: 'projektmanager-m-w-d-acme-corp-leibstadt',
      slugByLocale: {
        it: 'projektmanager-m-w-d-acme-corp-leibstadt',
        en: 'it-demand-manager-m-w-d-acme-corp-leibstadt',
      },
      titleByLocale: {
        it: 'Projektmanager (m/w/d)',
        en: 'IT Demand Manager',
      },
    };

    const report = applyPerLocaleSlugCollisionGuard([jobA, jobB]);

    expect(report.count).toBe(1);
    expect(jobA.slugByLocale.en).toBeUndefined();
    expect(jobA.titleByLocale.en).toBeUndefined();
    expect(jobA.needsRetranslation).toBe(true);
    // fr did NOT collide (no other job claims projektmanager-m-m-j-...): keep.
    expect(jobA.slugByLocale.fr).toBe('projektmanager-m-m-j-acme-corp-leibstadt');
    // de did NOT collide: keep.
    expect(jobA.slugByLocale.de).toBe('berechnungsingenieur-strukturmechanik-m-w-d-acme-corp-leibstadt');
    // Owner is untouched.
    expect(jobB.slug).toBe('projektmanager-m-w-d-acme-corp-leibstadt');
    expect(jobB.slugByLocale.en).toBe('it-demand-manager-m-w-d-acme-corp-leibstadt');
    expect(jobB.needsRetranslation).toBeUndefined();
  });

  it('does NOT flag a self-match (locale slug equals job own IT base)', () => {
    const job = {
      url: 'https://employer.example/jobs/x',
      canton: 'ZH',
      slug: 'my-role-acme-corp-zurich',
      slugByLocale: {
        it: 'my-role-acme-corp-zurich',
        en: 'my-role-acme-corp-zurich',
      },
      titleByLocale: { it: 'My role', en: 'My role' },
    };
    const report = applyPerLocaleSlugCollisionGuard([job]);
    expect(report.count).toBe(0);
    expect(job.slugByLocale.en).toBe('my-role-acme-corp-zurich');
    expect(job.needsRetranslation).toBeUndefined();
  });

  it('ignores collisions across different cantons (per-canton scoping)', () => {
    const jobAg = {
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'projektmanager-m-w-d-acme-corp-leibstadt',
      slugByLocale: { it: 'projektmanager-m-w-d-acme-corp-leibstadt' },
    };
    const jobZh = {
      url: 'https://employer.example/jobs/b',
      canton: 'ZH',
      slug: 'engineer-acme-corp-zurich',
      slugByLocale: {
        it: 'engineer-acme-corp-zurich',
        en: 'projektmanager-m-w-d-acme-corp-leibstadt',
      },
      titleByLocale: { en: 'Projektmanager' },
    };
    const report = applyPerLocaleSlugCollisionGuard([jobAg, jobZh]);
    // Different canton → not a collision; the AG natural owner doesn't reserve
    // the slug in ZH.
    expect(report.count).toBe(0);
    expect(jobZh.slugByLocale.en).toBe('projektmanager-m-w-d-acme-corp-leibstadt');
  });

  it('returns count=0 and no mutations when inputs are clean', () => {
    const jobs = [
      { url: 'a', canton: 'TI', slug: 'a-slug', slugByLocale: { it: 'a-slug', en: 'a-slug-en' } },
      { url: 'b', canton: 'TI', slug: 'b-slug', slugByLocale: { it: 'b-slug', en: 'b-slug-en' } },
    ];
    const before = JSON.stringify(jobs);
    const report = applyPerLocaleSlugCollisionGuard(jobs);
    expect(report.count).toBe(0);
    expect(JSON.stringify(jobs)).toBe(before);
  });

  it('caps the details list at 10 to keep build logs short', () => {
    const owner = {
      url: 'owner', canton: 'AG', slug: 'shared-slug-acme-corp-aarau',
      slugByLocale: { it: 'shared-slug-acme-corp-aarau' },
    };
    const claimants = Array.from({ length: 25 }, (_, i) => ({
      url: `claimant-${i}`,
      canton: 'AG',
      slug: `unique-${i}-acme-corp-aarau`,
      slugByLocale: {
        it: `unique-${i}-acme-corp-aarau`,
        en: 'shared-slug-acme-corp-aarau',
      },
      titleByLocale: { en: 'Hallucinated Title' },
    }));
    const report = applyPerLocaleSlugCollisionGuard([owner, ...claimants]);
    expect(report.count).toBe(25);
    expect(report.details).toHaveLength(10);
    for (const c of claimants) {
      expect(c.slugByLocale.en).toBeUndefined();
      expect(c.needsRetranslation).toBe(true);
    }
  });
});
