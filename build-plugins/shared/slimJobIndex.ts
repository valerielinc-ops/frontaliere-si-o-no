// slimJobIndex.ts
//
// Single source of truth for the SLIM job-index shape — the listing/routing/
// header subset of a job record, with the `*ByLocale` fields flattened to one
// locale. Used by BOTH:
//   1. localeJobsSplitPlugin — emits dist/data/jobs-<locale>-index.json
//   2. jobsSeoPagesPlugin    — injects window.__JOB_SEED__ into each active
//      job-detail page so the SPA can resolve `selectedJob` from the first
//      paint WITHOUT downloading the ~1.2 MB (gzip) slim index just to show
//      one job.
//
// Keeping the field set + flatten/slim helpers here means the seeded record is
// byte-shape-identical to its slim-index entry BY CONSTRUCTION. A copy-paste
// across the two plugins would let them drift (AGENTS.md §6).

/** Fields included in the slim index file (listing + filtering + routing + the
 * header/JSON-LD identification fields the detail view reads). Detail-only
 * fields (description, requirements, baseSalary, streetAddress, …) are excluded
 * and fetched on demand from /data/job-detail/<id>.json.
 *
 * `previousSlugs` / `previousSlugsByLocale` are DELIBERATELY ABSENT. They are
 * the slug-rename history, and the SPA already has a purpose-built, deployed
 * resolver for it: the sharded slug map (`services/jobSlugShards.ts` →
 * /data/jobs-slug-map/{00..ff}.json, ~16 KB br per shard, fetched per-slug via
 * `ensureJobSlugEntriesLoaded`). Carrying them here too duplicated that data
 * into every listing payload: measured on prod 2026-08-07, they were
 * 11.676.354 of the 27.957.668 bytes of jobs-it-index.json (41,8% raw /
 * 28,2% gzip) and they inflated the main-thread `registerJobSlugMap` Map from
 * 21.164 to 77.710 entries. Combined JSON.parse + registerJobSlugMap dropped
 * from 104,6 ms to 42,2 ms (median, desktop) by removing them — the INP lever,
 * since this work runs on the main thread after the SSG paint.
 *
 * Historic-slug URLs still resolve; see `tests/slim-index-previous-slugs-dedup.test.ts`
 * for the end-to-end proof (alias slug → shard → canonical slug + id + canton). */
export const SLIM_INDEX_FIELDS: ReadonlySet<string> = new Set([
  'id', 'slug',
  'title',
  'company', 'companyKey', 'companyDomain', 'url',
  'location', 'canton',
  // addressRegion: read by newsletter location matching (matchJobsForSubscriber
  // in services/newsletter-content.mjs) which consumes the slim index — without
  // it region-specific subscriber matching silently degrades.
  'addressLocality', 'addressRegion', 'sector',
  'category', 'contract', 'department',
  'salaryMin', 'salaryMax', 'currency', 'salarySource',
  'postedDate', 'crawledAt', 'firstSeenAt',
  'featured', 'source', 'qualityScore',
  // Publisher-ad fields: card logo + the apply-mode trio the detail view needs
  // to mount the in-house apply form (PublisherApplyForm).
  'companyLogo', 'tier', 'applyMode', 'publisherUid', 'publisherJobId',
]);

/** Number of records in the first-page slim asset (jobs-<locale>-index-first.json).
 * Sized well above the listing page size (10) so the SPA can paint page 1 — and a
 * little scroll headroom — from a tiny payload, then swap in the full index in the
 * background. Single source of truth shared by the emitter (localeJobsSplitPlugin)
 * and the JobBoard fetch path so the two can't drift on the slice boundary. */
export const FIRST_PAGE_SLICE_SIZE = 50;

/** Asset path (relative to /data) of the first-page slim index for a locale.
 * Keeping the path builder here means the emitter and the fetch path derive the
 * same URL by construction (AGENTS.md §6: no literal-duplicated path string). */
export function firstPageIndexFileName(locale: string): string {
  return `jobs-${locale}-index-first.json`;
}

export interface JobEntry {
  id?: string;
  title?: string;
  description?: string;
  requirements?: string[];
  slug?: string;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
  requirementsByLocale?: Record<string, string[]>;
  slugByLocale?: Record<string, string>;
  canonicalContent?: { byLocale?: Record<string, unknown>; [k: string]: unknown };
  [key: string]: unknown;
}

/** Flatten a multi-locale job record into a single-locale record (titleByLocale
 * → title, slugByLocale → slug, …). Mirrors the per-locale file generation. */
export function buildLocaleJob(job: JobEntry, locale: string): Record<string, unknown> {
  const {
    titleByLocale,
    descriptionByLocale,
    requirementsByLocale,
    slugByLocale,
    canonicalContent,
    ...rest
  } = job;

  // Strip byLocale from canonicalContent too (it holds per-locale keywords/excerpts).
  let strippedCanonical: Record<string, unknown> | undefined;
  if (canonicalContent) {
    const { byLocale, ...canonRest } = canonicalContent;
    const localeContent = byLocale?.[locale];
    strippedCanonical = { ...canonRest, ...(localeContent ? { content: localeContent } : {}) };
  }

  return {
    ...rest,
    title: titleByLocale?.[locale] || job.title || '',
    description: descriptionByLocale?.[locale] || job.description || '',
    requirements: requirementsByLocale?.[locale] || job.requirements || [],
    slug: slugByLocale?.[locale] || job.slug || '',
    ...(strippedCanonical ? { canonicalContent: strippedCanonical } : {}),
  };
}

/** Keep only SLIM_INDEX_FIELDS from a (locale-flattened) job record. */
export function buildLocaleJobSlim(localeJob: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_INDEX_FIELDS) {
    if (key in localeJob) slim[key] = localeJob[key];
  }
  return slim;
}

/** Locale-flattened slim record for one job — identical in shape to a
 * jobs-<locale>-index.json entry. This is what gets seeded into the active
 * job-detail page as window.__JOB_SEED__. */
export function buildSlimSeed(job: JobEntry, locale: string): Record<string, unknown> {
  return buildLocaleJobSlim(buildLocaleJob(job, locale));
}
