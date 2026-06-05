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
 * and fetched on demand from /data/job-detail/<id>.json. */
export const SLIM_INDEX_FIELDS: ReadonlySet<string> = new Set([
  'id', 'slug', 'previousSlugs', 'previousSlugsByLocale',
  'title',
  'company', 'companyKey', 'companyDomain', 'url',
  'location', 'canton',
  'addressLocality', 'sector',
  'category', 'contract', 'department',
  'salaryMin', 'salaryMax', 'currency',
  'postedDate', 'crawledAt', 'firstSeenAt',
  'featured', 'source', 'qualityScore',
]);

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
