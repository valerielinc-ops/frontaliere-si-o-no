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
 * collisions and assigns the claimant a deterministic suffix. The owner's
 * canonical route is never captured as claimant history (#6784).
 */

import { describe, it, expect } from 'vitest';
import { applyPerLocaleSlugCollisionGuard } from '../../scripts/assemble-jobs-dataset.mjs';

type LocaleMap = { it?: string; en?: string; de?: string; fr?: string };
type JobFixture = {
  slugByLocale?: LocaleMap;
  titleByLocale?: LocaleMap;
  needsRetranslation?: boolean;
  [key: string]: unknown;
};

describe('applyPerLocaleSlugCollisionGuard', () => {
  it('disambiguates EN slug when it collides with another job IT base in same canton', () => {
    const jobA: JobFixture = {
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
    const jobB: JobFixture = {
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
    expect(jobA.slugByLocale.en).toMatch(/^projektmanager-m-w-d-acme-corp-leibstadt-[a-z0-9]{6}$/);
    expect(jobA.titleByLocale.en).toBe('Projektmanager (m/w/d)');
    expect(jobA.needsRetranslation).toBeUndefined();
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
    const job: JobFixture = {
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

  it('never records the owner route as claimant history and preserves legitimate history', () => {
    const jobA: JobFixture = {
      id: 'job-a',
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'ingegnere-di-calcolo-meccanica-strutturale-m-f-d-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-di-calcolo-meccanica-strutturale-m-f-d-acme-corp-leibstadt',
        en: 'projektmanager-m-w-d-acme-corp-leibstadt',
      },
      titleByLocale: {
        it: 'Ingegnere di calcolo',
        en: 'Projektmanager (m/w/d)',
      },
      previousSlugs: ['legitimate-old-job-a-route'],
      previousSlugsByLocale: { en: ['legitimate-old-job-a-route'] },
    };
    const jobB: JobFixture = {
      id: 'job-b',
      url: 'https://employer.example/jobs/b',
      canton: 'AG',
      slug: 'projektmanager-m-w-d-acme-corp-leibstadt',
      slugByLocale: { it: 'projektmanager-m-w-d-acme-corp-leibstadt' },
      titleByLocale: { it: 'Projektmanager (m/w/d)' },
    };

    applyPerLocaleSlugCollisionGuard([jobA, jobB]);

    expect(jobA.slugByLocale.en).not.toBe('projektmanager-m-w-d-acme-corp-leibstadt');
    expect((jobA as any).previousSlugsByLocale?.en).toEqual(['legitimate-old-job-a-route']);
    expect((jobA as any).previousSlugs).toEqual(['legitimate-old-job-a-route']);
  });

  it('is idempotent when the exact same collision is evaluated again', () => {
    // A second assemble pass over the same in-memory job must not append the
    // stable suffix again or manufacture any slug-history entry.
    const jobA: JobFixture = {
      id: 'job-a',
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'ingegnere-di-calcolo-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-di-calcolo-acme-corp-leibstadt',
        en: 'projektmanager-m-w-d-acme-corp-leibstadt',
      },
      titleByLocale: {
        it: 'Ingegnere di calcolo',
        en: 'Projektmanager (m/w/d)',
      },
    };
    const jobB: JobFixture = {
      id: 'job-b',
      url: 'https://employer.example/jobs/b',
      canton: 'AG',
      slug: 'projektmanager-m-w-d-acme-corp-leibstadt',
      slugByLocale: { it: 'projektmanager-m-w-d-acme-corp-leibstadt' },
      titleByLocale: { it: 'Projektmanager (m/w/d)' },
    };

    const first = applyPerLocaleSlugCollisionGuard([jobA, jobB]);
    const slugAfterFirstPass = jobA.slugByLocale.en;
    const second = applyPerLocaleSlugCollisionGuard([jobA, jobB]);

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
    // Title is PRESERVED — nothing was actually wrong with the translation.
    expect(jobA.titleByLocale.en).toBe('Projektmanager (m/w/d)');
    // Slug is disambiguated (unique suffix), not deleted.
    expect(jobA.slugByLocale.en).not.toBeUndefined();
    expect(jobA.slugByLocale.en).not.toBe('projektmanager-m-w-d-acme-corp-leibstadt');
    expect(jobA.slugByLocale.en!.startsWith('projektmanager-m-w-d-acme-corp-leibstadt-')).toBe(true);
    expect(jobA.slugByLocale.en).toBe(slugAfterFirstPass);
    expect((jobA as any).previousSlugs).toBeUndefined();
    expect((jobA as any).previousSlugsByLocale).toBeUndefined();
    // No retranslation flag — there is nothing to retranslate.
    expect(jobA.needsRetranslation).toBeUndefined();
  });

  it('caps the details list at 10 to keep build logs short', () => {
    const owner = {
      url: 'owner', canton: 'AG', slug: 'shared-slug-acme-corp-aarau',
      slugByLocale: { it: 'shared-slug-acme-corp-aarau' },
    };
    const claimants: JobFixture[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://employer.example/jobs/claimant-${i}`,
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
      expect(c.slugByLocale.en).toMatch(/^shared-slug-acme-corp-aarau-[a-z0-9]{6}$/);
      expect(c.needsRetranslation).toBeUndefined();
    }
  });

  it('assigns the same claimant routes regardless of input order', () => {
    const fixtures = () => ([
      {
        id: 'owner', url: 'https://employer.example/jobs/owner', canton: 'AG',
        slug: 'shared-role-acme-aarau', slugByLocale: { it: 'shared-role-acme-aarau' },
      },
      {
        id: 'claimant-a', url: 'https://employer.example/jobs/a', canton: 'AG',
        slug: 'role-a-acme-aarau', slugByLocale: { it: 'role-a-acme-aarau', en: 'shared-role-acme-aarau' },
      },
      {
        id: 'claimant-b', url: 'https://employer.example/jobs/b', canton: 'AG',
        slug: 'role-b-acme-aarau', slugByLocale: { it: 'role-b-acme-aarau', en: 'shared-role-acme-aarau' },
      },
    ]);
    const forward = fixtures();
    const reversed = fixtures().reverse();

    applyPerLocaleSlugCollisionGuard(forward);
    applyPerLocaleSlugCollisionGuard(reversed);

    const byUrl = (jobs) => Object.fromEntries(jobs.map((job) => [job.url, job.slugByLocale.en]));
    expect(byUrl(reversed)).toEqual(byUrl(forward));
  });
});

/**
 * These tests lock the SAFETY PROPERTY the assembler relies on, independent of the
 * registry: after the guard runs, the EFFECTIVE per-locale slug the build emits
 * (`slugByLocale[locale] ?? job.slug`, mirroring localizedSlug() in
 * build-plugins/jobsSeoPagesPlugin.ts) stays UNIQUE within every (canton, locale).
 */
describe('applyPerLocaleSlugCollisionGuard — post-guard fallback safety (#1072)', () => {
  // Effective slug the build actually emits per locale: explicit per-locale slug,
  // else the IT base slug. Mirrors localizedSlug() steps 1–2 in jobsSeoPagesPlugin.ts.
  const effectiveSlug = (job, locale) =>
    String(job?.slugByLocale?.[locale] || '').trim() || String(job?.slug || '').trim();

  // Asserts no two jobs share an effective (canton, locale, slug) tuple.
  const assertNoCantonLocaleCollision = (jobs, locales) => {
    for (const locale of locales) {
      const seen = new Map();
      for (const job of jobs) {
        const canton = String(job?.canton || 'TI').toUpperCase();
        const slug = effectiveSlug(job, locale);
        if (!slug) continue;
        const key = `${canton}|${slug}`;
        expect(
          seen.has(key),
          `effective ${locale} collision ${key}: ${seen.get(key)} vs ${job.url}`,
        ).toBe(false);
        seen.set(key, job.url);
      }
    }
  };

  it('after the guard disambiguates a colliding locale slug, the effective slug stays unique in every locale', () => {
    const jobA: JobFixture = {
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'ingegnere-di-calcolo-meccanica-strutturale-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-di-calcolo-meccanica-strutturale-acme-corp-leibstadt',
        en: 'projektmanager-m-w-d-acme-corp-leibstadt', // collides with jobB IT base
        de: 'berechnungsingenieur-strukturmechanik-acme-corp-leibstadt',
        fr: 'ingenieur-de-calcul-acme-corp-leibstadt',
      },
      titleByLocale: { it: 'Ingegnere', en: 'Projektmanager', de: 'Berechnung', fr: 'Ingénieur' },
    };
    const jobB = {
      url: 'https://employer.example/jobs/b',
      canton: 'AG',
      slug: 'projektmanager-m-w-d-acme-corp-leibstadt',
      slugByLocale: {
        it: 'projektmanager-m-w-d-acme-corp-leibstadt',
        en: 'it-demand-manager-acme-corp-leibstadt',
      },
      titleByLocale: { it: 'Projektmanager', en: 'IT Demand Manager' },
    };

    const report = applyPerLocaleSlugCollisionGuard([jobA, jobB]);

    expect(report.count).toBe(1);
    expect(jobA.slugByLocale.en).toMatch(/^projektmanager-m-w-d-acme-corp-leibstadt-[a-z0-9]{6}$/);
    expect(jobA.needsRetranslation).toBeUndefined();
    expect(effectiveSlug(jobA, 'en')).not.toBe(effectiveSlug(jobB, 'en'));
    // The whole set is collision-free in every locale post-guard.
    assertNoCantonLocaleCollision([jobA, jobB], ['it', 'en', 'de', 'fr']);
  });

  it('does not relocate the collision when two distinct jobs both claim the same base in the same locale', () => {
    // jobA.en and jobC.en both claim jobOwner's IT base. Each claimant must
    // receive its own suffix, never the owner's route or each other's.
    const owner = {
      url: 'https://employer.example/jobs/owner',
      canton: 'AG',
      slug: 'projektmanager-acme-corp-leibstadt',
      slugByLocale: { it: 'projektmanager-acme-corp-leibstadt' },
    };
    const jobA: JobFixture = {
      url: 'https://employer.example/jobs/a',
      canton: 'AG',
      slug: 'ingegnere-a-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-a-acme-corp-leibstadt',
        en: 'projektmanager-acme-corp-leibstadt',
      },
      titleByLocale: { en: 'Hallucinated A' },
    };
    const jobC: JobFixture = {
      url: 'https://employer.example/jobs/c',
      canton: 'AG',
      slug: 'ingegnere-c-acme-corp-leibstadt',
      slugByLocale: {
        it: 'ingegnere-c-acme-corp-leibstadt',
        en: 'projektmanager-acme-corp-leibstadt',
      },
      titleByLocale: { en: 'Hallucinated C' },
    };

    const report = applyPerLocaleSlugCollisionGuard([owner, jobA, jobC]);

    expect(report.count).toBe(2);
    expect(jobA.slugByLocale.en).toMatch(/^projektmanager-acme-corp-leibstadt-[a-z0-9]{6}$/);
    expect(jobC.slugByLocale.en).toMatch(/^projektmanager-acme-corp-leibstadt-[a-z0-9]{6}$/);
    expect(jobA.slugByLocale.en).not.toBe(jobC.slugByLocale.en);
    expect(jobA.needsRetranslation).toBeUndefined();
    expect(jobC.needsRetranslation).toBeUndefined();
    assertNoCantonLocaleCollision([owner, jobA, jobC], ['it', 'en', 'de', 'fr']);
  });
});
