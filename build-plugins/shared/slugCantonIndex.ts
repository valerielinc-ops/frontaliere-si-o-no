/**
 * Slug → canton reverse index, built lazily on first lookup from
 * `data/slug-registry.json` + `data/jobs.json` (both read at plugin-runtime via
 * the shared lazy loader — never statically imported, see `loadDataJson.ts`).
 *
 * Used by jobOrphanBridgePlugin to infer which canton section a *matched/current*
 * job-slug should redirect to. (searchConsoleCompat no longer uses it: since
 * #2041 per-canton job paths canonicalize to the canton already present in the
 * URL rather than re-deriving it from the — often expired — slug.)
 *
 * Behavior contract (TI invariance):
 * - If a slug is unknown, return 'TI' so the redirect target is byte-identical
 *   to the legacy behavior.
 * - If a slug appears with multiple cantons (1.9k conflicts across the two
 *   sources), the *last write wins*. This is acceptable because the redirect
 *   target only needs to land on a valid canton section; the job-detail page
 *   itself is emitted by `jobsSeoPagesPlugin` on the correct section path.
 */

import { loadDataJson } from './loadDataJson';
import { loadJobsJson } from './loadJobsJson';

type RegistryEntry = {
  canonicalSlug?: string;
  slugByLocale?: Record<string, string>;
  canton?: string;
};

type JobEntry = {
  slug?: string;
  slugByLocale?: Record<string, string>;
  canton?: string;
};

let slugToCanton: Map<string, string> | null = null;

function build(): Map<string, string> {
  const map = new Map<string, string>();
  const registry = loadDataJson<Record<string, RegistryEntry>>('data/slug-registry.json');
  for (const entry of Object.values(registry)) {
    const canton = String(entry?.canton || 'TI').toUpperCase().trim() || 'TI';
    if (entry?.canonicalSlug) map.set(entry.canonicalSlug, canton);
    if (entry?.slugByLocale) {
      for (const s of Object.values(entry.slugByLocale)) {
        if (s) map.set(s, canton);
      }
    }
  }
  const jobs = loadJobsJson<JobEntry>();
  for (const job of jobs) {
    const canton = String(job?.canton || 'TI').toUpperCase().trim() || 'TI';
    if (job?.slug) map.set(job.slug, canton);
    if (job?.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) {
        if (s) map.set(s, canton);
      }
    }
  }
  return map;
}

/** Get canton code (e.g. 'TI', 'GR', 'VS') for a job slug, falling back to 'TI'. */
export function getCantonForSlug(slug: string): string {
  if (!slugToCanton) slugToCanton = build();
  if (!slug) return 'TI';
  return slugToCanton.get(slug) || 'TI';
}

/** Return the full index (test/debug). */
export function getSlugCantonIndex(): ReadonlyMap<string, string> {
  if (!slugToCanton) slugToCanton = build();
  return slugToCanton;
}
