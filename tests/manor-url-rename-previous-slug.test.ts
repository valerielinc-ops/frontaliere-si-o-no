/**
 * Regression test for issue #3699 ("previousSlugs writer regression",
 * 3rd recurrence): `scripts/update-manor-jobs.mjs`'s own hand-rolled
 * `mergeManorJobs` indexed existing jobs by the RAW normalized URL. Manor's
 * jobs2web (SAP SuccessFactors) sitemap URLs embed the human title before
 * the trailing numeric requisition id
 * (`.../job/Basel-Senior-Project-Manager-100/1234567890/`), so any title
 * edit on the vendor side (observed live: adding a "*in" gender marker)
 * rewrites the URL on the next crawl. The exact-URL match then missed,
 * so the old record (carrying previousSlugs/previousSlugsByLocale/
 * firstSeenAt/translations) was dropped as "no longer in the feed" while
 * the freshly-scraped job was pushed as brand new — silently destroying
 * the slug-history needed for the redirect/bridge-page continuity, with
 * no addPreviousSlugForLocale/captureLostSlugs journal entry at all
 * (confirmed live via `git diff eb8a1def09d 22b076bb0e -- data/jobs/by-crawler/manor.json`).
 *
 * The fix routes the reconciliation through the shared
 * `mergePreserveLocaleData`, whose default matchKey
 * (`extractStableJobId(url)`) extracts the stable trailing numeric id and
 * ignores the title-slug prefix, so a title-driven URL rewrite is matched
 * as an UPDATE (captures the old slug, keeps firstSeenAt, keeps existing
 * translations) instead of a delete+insert.
 *
 * Note on job shape: the Manor parser (`scripts/update-manor-jobs.mjs`)
 * only ever populates the raw-crawl locale slot under the `it` key
 * (`slugByLocale: { it: baseSlug }` plus the legacy top-level `slug`) —
 * the en/de/fr slots are filled later by the separate AI translation
 * pipeline. `mergeLocaleTextMap` deliberately keeps the EXISTING value for
 * every non-source locale (never lets raw crawl noise clobber a real
 * translation), so this test's "fresh" object mirrors that shape instead
 * of asserting a per-locale rename the crawler itself never produces.
 */
import { describe, expect, it } from 'vitest';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const JOB_ID = '1359500855';
const MANOR_URL = (titleSlug: string) =>
  `https://positions.manor.ch/job/${titleSlug}/${JOB_ID}/`;

const OLD_SLUG = 'manor-gestionnaire-de-projet-principal-100-basel-senior-project-managerin';
const OLDER_SLUG = 'manor-direttore-principale-di-progetto-100-basel-senior-project-managerin';
const NEW_SLUG = 'manor-senior-project-manager-in-100-basel-senior-project-managerin';

describe('Manor jobs2web title rewrite keeps the old slug bridgeable (issue #3699)', () => {
  it('matches old<->fresh on the stable trailing requisition id and carries previousSlugs/firstSeenAt/translations forward', () => {
    const base = {
      id: 'manor-e71e1c9a8b7e',
      company: 'Manor AG',
      companyKey: 'manor',
      location: 'Basel',
      addressLocality: 'Basel',
      canton: 'BS',
      sourceLang: 'it',
      source: 'company-website',
    };

    const existing = [{
      ...base,
      url: MANOR_URL('Basel-Gestionnaire-de-projet-principal-100-Senior-Project-Managerin'),
      title: 'Gestionnaire de projet principal 100%',
      slug: OLD_SLUG,
      slugByLocale: {
        it: OLD_SLUG,
        en: 'manor-senior-project-manager-100-basel-senior-project-managerin',
        de: 'manor-senior-projektmanager-100-basel-senior-project-managerin',
        fr: OLD_SLUG,
      },
      titleByLocale: { it: 'Gestionnaire de projet principal 100%' },
      descriptionByLocale: {
        it: 'x'.repeat(200),
        en: 'y'.repeat(200),
        de: 'z'.repeat(200),
        fr: 'w'.repeat(200),
      },
      previousSlugsByLocale: { it: [OLDER_SLUG] },
      previousSlugs: [OLDER_SLUG],
      firstSeenAt: '2026-07-05T23:35:51.230Z',
      crawledAt: '2026-07-05T23:35:51.230Z',
    }];

    const fresh = [{
      ...base,
      // Vendor edited the title (added the "*in" gender marker), which
      // rewrites the jobs2web URL's title-slug segment; the trailing
      // numeric requisition id is unchanged. The raw crawl only ever
      // repopulates the `it` slot (+ legacy top-level `slug`) — it never
      // touches en/de/fr, those are translation-pipeline territory.
      url: MANOR_URL('Basel-Senior-Project-Manager-in-100-Senior-Project-Managerin'),
      title: 'Senior Project Manager*in 100%',
      slug: NEW_SLUG,
      slugByLocale: { it: NEW_SLUG },
      titleByLocale: { it: 'Senior Project Manager*in 100%' },
      descriptionByLocale: { it: 'x'.repeat(200) },
      crawledAt: '2026-07-06T14:30:45.624Z',
    }];

    const merged = mergePreserveLocaleData(existing, fresh, {});
    expect(merged).toHaveLength(1);
    const job = merged[0];

    // Stable id preserved across the URL rewrite (no delete+insert).
    expect(job.id).toBe('manor-e71e1c9a8b7e');

    // Old IT slug (dropped by the URL rewrite) is captured for the redirect
    // bridge, and the pre-existing history entry survives too.
    const carriedPrev = [
      ...(job.previousSlugs || []),
      ...((job.previousSlugsByLocale && job.previousSlugsByLocale.it) || []),
    ];
    expect(carriedPrev).toContain(OLD_SLUG);
    expect(carriedPrev).toContain(OLDER_SLUG);

    // firstSeenAt must not reset just because the vendor rewrote the URL.
    expect(job.firstSeenAt).toBe('2026-07-05T23:35:51.230Z');

    // The active IT slug (and legacy master slug) advance to the new posting.
    expect(job.slugByLocale.it).toBe(NEW_SLUG);
    expect(job.slug).toBe(NEW_SLUG);

    // Existing EN/DE/FR translations (never re-supplied by the raw crawl)
    // must be preserved untouched — the merge must not clobber real
    // translations with source-language crawl noise, nor fabricate a
    // previousSlugs entry for locales that never actually changed.
    expect(job.slugByLocale.en).toBe('manor-senior-project-manager-100-basel-senior-project-managerin');
    expect(job.slugByLocale.de).toBe('manor-senior-projektmanager-100-basel-senior-project-managerin');
    expect(job.slugByLocale.fr).toBe(OLD_SLUG);
    expect(job.previousSlugsByLocale.en || []).toHaveLength(0);
  });
});
