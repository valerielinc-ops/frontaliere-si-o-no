/**
 * useExpiredJob — lazy-fetch hook for expired job metadata.
 *
 * Fetches the slim /data/expired-jobs-index.json once (module-level cache),
 * matches the given slug (any locale slug or previous slug), then lazy-fetches
 * the matched entry's /data/expired-detail/<key>.json for the description. This
 * replaces fetching the whole ~11MB-gz expired-jobs.json monolith on every SPA
 * navigation to an expired job. Only initiates the fetch for a non-nullish slug.
 */

import { useEffect, useState } from 'react';
import { cdnDataUrl } from '@/services/cdnDataBase';

export interface ExpiredJob {
 slug: string;
 title: string;
 titleByLocale?: Record<string, string>;
 company: string;
 companyKey?: string;
 location?: string;
 addressLocality?: string;
 descriptionByLocale?: Record<string, string>;
 slugByLocale?: Record<string, string>;
 previousSlugs?: string[];
 previousSlugsByLocale?: Record<string, string[]>;
 sector?: string;
 expiredAt?: string;
 /** Detail-file key — present on slim index entries; points at expired-detail/<key>.json. */
 key?: string;
}

// Module-level caches — shared across all hook instances.
let cachedExpiredIndex: ExpiredJob[] | null = null;
let indexFetchPromise: Promise<ExpiredJob[]> | null = null;
const detailCache = new Map<string, ExpiredJob | null>();

function fetchExpiredIndex(): Promise<ExpiredJob[]> {
 if (cachedExpiredIndex) return Promise.resolve(cachedExpiredIndex);
 if (!indexFetchPromise) {
 indexFetchPromise = fetch(cdnDataUrl('/data/expired-jobs-index.json'))
 .then((r) => r.json() as Promise<ExpiredJob[]>)
 .then((data) => {
 cachedExpiredIndex = data;
 return data;
 })
 .catch(() => {
 indexFetchPromise = null; // allow retry on next call
 return [] as ExpiredJob[];
 });
 }
 return indexFetchPromise;
}

function fetchExpiredDetail(key: string): Promise<ExpiredJob | null> {
 if (detailCache.has(key)) return Promise.resolve(detailCache.get(key) ?? null);
 return fetch(cdnDataUrl(`/data/expired-detail/${key}.json`))
 .then((r) => (r.ok ? (r.json() as Promise<ExpiredJob>) : null))
 .then((d) => {
 detailCache.set(key, d);
 return d;
 })
 .catch(() => {
 detailCache.set(key, null);
 return null;
 });
}

function matchExpiredSlug(job: ExpiredJob, slug: string): boolean {
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
 * Read job data seeded by the build plugin into window.__EXPIRED_JOB_DATA__.
 * This ensures expired pages have rich content even for jobs that are not in
 * the runtime expired-jobs.json (which only contains recently expired jobs).
 */
function getSeededExpiredJob(): ExpiredJob | null {
 try {
 const raw = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
 if (raw && typeof raw === 'object' && 'slug' in (raw as Record<string, unknown>)) {
 const candidate = raw as ExpiredJob;
 // Seeded data must have a meaningful title — empty objects injected for
 // slugs without metadata in expired-jobs.json should fall through to the
 // orphan view instead of rendering a broken JobExpiredView.
 if (!candidate.title?.trim()) return null;
 return candidate;
 }
 } catch { /* SSR or missing */ }
 return null;
}

/**
 * Returns true when the build-seeded expired job data matches the given slug.
 * Used to distinguish job slugs that start with a company prefix
 * (e.g. "azienda-multiservizi-bellinzona-amb") from company filter slugs
 * (e.g. "azienda-migros") — the seeded data is slug-specific so stale window
 * globals from a previous SPA page load cannot produce a false match.
 */
export function seededJobMatchesSlug(slug: string): boolean {
  try {
    const raw = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
    if (!raw || typeof raw !== 'object') return false;
    const job = raw as {
      slug?: string;
      slugByLocale?: Record<string, string>;
      previousSlugs?: string[];
      previousSlugsByLocale?: Record<string, string[]>;
    };
    if (job.slug === slug) return true;
    if (job.slugByLocale && Object.values(job.slugByLocale).some((s) => s === slug)) return true;
    if (job.previousSlugs && job.previousSlugs.includes(slug)) return true;
    if (job.previousSlugsByLocale) {
      for (const arr of Object.values(job.previousSlugsByLocale)) {
        if (Array.isArray(arr) && arr.includes(slug)) return true;
      }
    }
    return false;
  } catch { return false; }
}

/**
 * Returns true when the build plugin injected expired job data into this page.
 * Callable from outside the hook (e.g. to short-circuit a loading spinner).
 */
export function hasSeededExpiredData(): boolean {
 try {
 const raw = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
 // Check for slug only — title may be empty for orphan slugs that have no
 // enrichment data. Guard 1 in JobBoard.tsx must still fire for these pages
 // to prevent the canonical from falling through to the listing page URL.
 return !!(raw && typeof raw === 'object' && 'slug' in (raw as Record<string, unknown>) &&
 (raw as Record<string, string>).slug?.trim());
 } catch { return false; }
}

export function useExpiredJob(slug: string | undefined): {
 expiredJob: ExpiredJob | null;
 loading: boolean;
} {
 const [expiredJob, setExpiredJob] = useState<ExpiredJob | null>(null);
 const [loading, setLoading] = useState(Boolean(slug));

 useEffect(() => {
 if (!slug) {
 setLoading(false);
 setExpiredJob(null);
 return;
 }

 // 1. Try window global first (seeded by build plugin — always available on expired pages)
 const seeded = getSeededExpiredJob();
 if (seeded && matchExpiredSlug(seeded, slug)) {
 setExpiredJob(seeded);
 setLoading(false);
 return;
 }

 // 2. Fall back to runtime fetch (for SPA navigation to expired jobs):
 //    slim index → match → lazy-fetch the matched entry's detail file for
 //    its descriptionByLocale.
 let cancelled = false;
 setLoading(true);
 fetchExpiredIndex().then(async (jobs) => {
 if (cancelled) return;
 const found = jobs.find((j) => matchExpiredSlug(j, slug)) ?? null;
 if (!found) {
 setExpiredJob(null);
 setLoading(false);
 return;
 }
 const detail = found.key ? await fetchExpiredDetail(found.key) : null;
 if (cancelled) return;
 // Detail carries descriptionByLocale; merge over the slim index entry.
 setExpiredJob(detail ? { ...found, ...detail } : found);
 setLoading(false);
 });
 return () => { cancelled = true; };
 }, [slug]);

 // Synchronous override: return seeded data during render even before the
 // effect fires. This prevents an intermediate render frame (loading=false,
 // expiredJob=null) that would flash <JobOrphanView> before the effect sets state.
 if (slug) {
 const seeded = getSeededExpiredJob();
 if (seeded && matchExpiredSlug(seeded, slug)) {
 return { expiredJob: seeded, loading: false };
 }
 }

 return { expiredJob, loading };
}
