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
import { applyPerLocaleSlugCollisionGuard } from '../../scripts/assemble-jobs-dataset.mjs';

type LocaleMap = { it?: string; en?: string; de?: string; fr?: string };
type JobFixture = {
  slugByLocale?: LocaleMap;
  titleByLocale?: LocaleMap;
  needsRetranslation?: boolean;
  [key: string]: unknown;
};

describe('applyPerLocaleSlugCollisionGuard', () => {
  it('drops EN slug + title when it collides with another job IT base in same canton', () => {
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

  it('preserves the dropped locale slug in previousSlugs/previousSlugsByLocale (issues #3546/#3534)', () => {
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

    expect(jobA.slugByLocale.en).toBeUndefined();
    // The dropped EN slug must not be lost — it's captured as history so the
    // bridge/redirect keeps resolving the old indexed URL.
    expect((jobA as any).previousSlugsByLocale?.en).toContain('projektmanager-m-w-d-acme-corp-leibstadt');
    expect((jobA as any).previousSlugs).toContain('projektmanager-m-w-d-acme-corp-leibstadt');
  });

  it('caps the details list at 10 to keep build logs short', () => {
    const owner = {
      url: 'owner', canton: 'AG', slug: 'shared-slug-acme-corp-aarau',
      slugByLocale: { it: 'shared-slug-acme-corp-aarau' },
    };
    const claimants: JobFixture[] = Array.from({ length: 25 }, (_, i) => ({
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

/**
 * Deferred edge from #1068 → #1072: the guard's `delete job.slugByLocale[locale]`
 * (assemble-jobs-dataset.mjs:~275) was flagged as a theoretical risk — dropping a
 * colliding locale slug strands the job onto its IT-base-slug fallback, and an audit
 * worried this could simply *relocate* the collision onto the fallback path and emit
 * a non-canonical URL → 404 on an already-indexed slug.
 *
 * These tests lock the SAFETY PROPERTY the assembler relies on, independent of the
 * registry: after the guard runs, the EFFECTIVE per-locale slug the build emits
 * (`slugByLocale[locale] ?? job.slug`, mirroring localizedSlug() in
 * build-plugins/jobsSeoPagesPlugin.ts) stays UNIQUE within every (canton, locale).
 * The delete must never move a collision onto the fallback base. The registry-aware
 * behavior change (PR #1068 `## Non implementato`) stays deferred per the issue —
 * escalate to a real fix only on observed GSC 404s.
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

  it('after the guard drops a colliding locale slug, the fallback effective slug stays unique in every locale', () => {
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
    expect(jobA.slugByLocale.en).toBeUndefined();
    expect(jobA.needsRetranslation).toBe(true);
    // The dropped EN slug falls back to jobA's own (unique) IT base, NOT onto jobB.
    expect(effectiveSlug(jobA, 'en')).toBe(jobA.slug);
    expect(effectiveSlug(jobA, 'en')).not.toBe(effectiveSlug(jobB, 'en'));
    // The whole set is collision-free in every locale post-guard.
    assertNoCantonLocaleCollision([jobA, jobB], ['it', 'en', 'de', 'fr']);
  });

  it('does not relocate the collision when two distinct jobs both claim the same base in the same locale', () => {
    // The adversarial "stranding" case: jobA.en and jobC.en BOTH hallucinate
    // jobOwner's IT base. The guard must drop both → each falls back to its OWN
    // distinct IT base, never onto each other or onto the owner.
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
    expect(jobA.slugByLocale.en).toBeUndefined();
    expect(jobC.slugByLocale.en).toBeUndefined();
    expect(jobA.needsRetranslation).toBe(true);
    expect(jobC.needsRetranslation).toBe(true);
    // Both fall back to their own distinct bases — collision is NOT relocated.
    expect(effectiveSlug(jobA, 'en')).toBe('ingegnere-a-acme-corp-leibstadt');
    expect(effectiveSlug(jobC, 'en')).toBe('ingegnere-c-acme-corp-leibstadt');
    assertNoCantonLocaleCollision([owner, jobA, jobC], ['it', 'en', 'de', 'fr']);
  });
});
