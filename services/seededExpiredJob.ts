// seededExpiredJob.ts
//
// `window.__EXPIRED_JOB_DATA__` is baked into the static HTML of ONE expired
// job page by build-plugins/jobsSeoPagesPlugin, and — like
// `__BRIDGE_TARGET_SLUG__` — the SPA never updates or clears it. Any consumer
// that checks only whether the global EXISTS will therefore keep believing
// "this is that expired job" for every route reached by soft-navigation
// afterwards.
//
// So the slug-specific match below is the only safe way to read it, and it now
// has two consumers (hooks/useExpiredJob for the view, services/seoService for
// the metadata guard). It lives here, alone and dependency-free, so the two
// cannot drift and so importing it from a service does not drag React and the
// expired-job fetch machinery into a core chunk (AGENTS.md §6: a construct
// needed by ≥2 files → one shared module).

/** Slug-bearing shape of the build-seeded expired job blob. */
export interface SeededExpiredJobSlugs {
  slug?: string;
  slugByLocale?: Record<string, string>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Record<string, string[]>;
}

/**
 * True when `job` is known by `slug` under ANY of its names: the canonical
 * slug, a per-locale slug, or a historic (renamed) slug, flat or locale-aware.
 *
 * Matching all four matters — an expired job page is legitimately served under
 * its locale slugs and its previous slugs, so a bare `job.slug === slug` check
 * would reject real expired pages and let their static metadata be overwritten.
 */
export function expiredJobMatchesSlug(job: SeededExpiredJobSlugs, slug: string): boolean {
  if (!job || !slug) return false;
  if (job.slug === slug) return true;
  if (job.slugByLocale && Object.values(job.slugByLocale).some((s) => s === slug)) return true;
  if (job.previousSlugs && job.previousSlugs.includes(slug)) return true;
  if (job.previousSlugsByLocale) {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr) && arr.includes(slug)) return true;
    }
  }
  return false;
}

/**
 * True when the build-seeded expired job data on THIS document describes the
 * given slug. Returns false when the global is absent, malformed, or belongs to
 * a page we have since navigated away from — which is exactly the false match
 * that a presence-only check produces after an SPA soft-navigation.
 */
export function seededJobMatchesSlug(slug: string): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const raw = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
    if (!raw || typeof raw !== 'object') return false;
    return expiredJobMatchesSlug(raw as SeededExpiredJobSlugs, slug);
  } catch {
    return false;
  }
}
