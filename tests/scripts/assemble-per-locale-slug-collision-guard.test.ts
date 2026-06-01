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

  // Verification for the deferred edge tracked in issue #1072 (follow-up of
  // PR #1068): `delete job.slugByLocale[locale]` runs on a base-slug collision
  // without consulting the slug registry. The worry is that dropping a
  // (potentially registry-pinned) locale slug could strand an indexed
  // per-locale URL. This test pins the actual safety contract: whatever the
  // guard drops, the *post-assembler* slug resolution stays collision-free in
  // every locale and the dropped job self-heals via needsRetranslation. The
  // build's localizedSlug() falls back to the IT base slug — which the upstream
  // IT-base dedup already guaranteed unique — so no two jobs ever emit the same
  // per-locale URL. (Behavior change to make the guard registry-aware is
  // deliberately deferred; see issue #1072 — escalate only if GSC shows real
  // 404s.)
  it('leaves no surviving per-locale collision after resolving a base-slug clash', () => {
    // jobB owns the IT base slug `senior-engineer-acme-corp-lugano`. jobA's EN
    // slug is identical to it — the exact stranding scenario the issue worries
    // about (as if jobA had a registry-pinned EN translation colliding with a
    // sibling's IT base).
    const jobA = {
      url: 'https://employer.example/jobs/a',
      canton: 'TI',
      slug: 'ingegnere-senior-acme-corp-lugano',
      slugByLocale: {
        it: 'ingegnere-senior-acme-corp-lugano',
        en: 'senior-engineer-acme-corp-lugano',
      },
      titleByLocale: { it: 'Ingegnere senior', en: 'Senior Engineer' },
    };
    const jobB = {
      url: 'https://employer.example/jobs/b',
      canton: 'TI',
      slug: 'senior-engineer-acme-corp-lugano',
      slugByLocale: { it: 'senior-engineer-acme-corp-lugano' },
      titleByLocale: { it: 'Senior Engineer' },
    };

    const report = applyPerLocaleSlugCollisionGuard([jobA, jobB]);
    expect(report.count).toBe(1);
    // jobA dropped its colliding EN slug and is flagged for retranslation so the
    // next crawl regenerates (and the registry re-pins) a fresh, unique slug.
    expect(jobA.slugByLocale.en).toBeUndefined();
    expect(jobA.needsRetranslation).toBe(true);

    // Post-assembler safety property: resolve each job's effective per-locale
    // slug (the value the build would emit, with fallback to the IT base) and
    // assert no two jobs share one in the same locale — i.e. the guard did not
    // merely move the collision to the fallback path.
    const jobs = [jobA, jobB];
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const effective = jobs.map((j) =>
        String(j.slugByLocale?.[locale] || j.slug || '').trim(),
      );
      const unique = new Set(effective);
      expect(unique.size).toBe(effective.length);
    }
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
