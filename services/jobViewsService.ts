/**
 * Job Page View Tracking — Firestore-backed view counter
 *
 * Same pattern as article_views in BlogArticles.tsx.
 * Collection: `job_views`, document key: canonical (Italian) job slug.
 *
 * Why canonical: a single job has up to 4 different slugs (one per locale,
 * see localeJobsSplitPlugin) plus a rename history. Writing under the IT
 * slug keeps the counter unified across locales and avoids fragmenting the
 * popularity signal used by the newsletter ranker.
 *
 * Debounced: max 1 increment per session per job via sessionStorage.
 */

import type { Firestore } from 'firebase/firestore';

let _db: Firestore | null = null;
let _dbInit = false;

type LocaleSlugMap = Partial<Record<'it' | 'en' | 'de' | 'fr', string>>;

interface TrackableJob {
  id?: string;
  slug?: string;
  slugByLocale?: LocaleSlugMap;
  previousSlugsByLocale?: Partial<Record<'it' | 'en' | 'de' | 'fr', string[]>>;
}

/**
 * Resolve the canonical (IT) slug for a job. Falls back to the current
 * locale-flattened slug if the IT variant isn't available — which can happen
 * when the per-job detail file hasn't loaded yet.
 */
function resolveCanonicalSlug(job: TrackableJob): string {
  const it = job.slugByLocale?.it;
  if (it) return it;
  // Pre-detail-load fallback: the slim index has only the locale-flattened slug.
  // Using it here means we *might* write under a non-canonical slug for the
  // brief window before detail data arrives. The newsletter matcher reconciles
  // these via getJobPopularityCount in services/newsletter-content.mjs.
  return job.slug || '';
}

/**
 * Track a view for a job page. Non-blocking, fire-and-forget.
 *
 * Accepts either:
 *  - a string slug (legacy / scripts) → written as-is
 *  - a job object → writes under canonical IT slug
 *
 * Debounces via sessionStorage so each job counts once per browser session.
 */
export async function trackJobView(slugOrJob: string | TrackableJob): Promise<void> {
  const job: TrackableJob = typeof slugOrJob === 'string' ? { slug: slugOrJob } : slugOrJob;
  const writeSlug = resolveCanonicalSlug(job);
  if (!writeSlug) return;

  // Debounce key prefers the stable job id when available, falling back to
  // the canonical slug. Same job → same key regardless of which locale variant
  // was tried first.
  const debounceKey = `jv_${job.id || writeSlug}`;
  try {
    if (sessionStorage.getItem(debounceKey)) return;
    sessionStorage.setItem(debounceKey, '1');
  } catch {
    // sessionStorage unavailable — proceed anyway (no debounce)
  }

  try {
    if (!_dbInit) {
      _dbInit = true;
      const { getFirestore } = await import('firebase/firestore');
      const { app } = await import('@/services/firebase');
      _db = getFirestore(app);
    }
    if (!_db) return;

    const { doc, setDoc, increment } = await import('firebase/firestore');
    await setDoc(
      doc(_db, 'job_views', writeSlug),
      { views: increment(1), lastViewed: new Date() },
      { merge: true },
    );
  } catch {
    // Non-blocking — never break job page loading
  }
}
