/**
 * useExpiredJob — lazy-fetch hook for expired job metadata.
 *
 * Fetches /data/expired-jobs.json once (module-level cache) and returns the
 * first job matching the given slug (any locale slug). Only initiates the
 * fetch when called with a non-nullish slug.
 */

import { useEffect, useState } from 'react';

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
 sector?: string;
 expiredAt?: string;
}

// Module-level cache — shared across all hook instances
let cachedExpiredJobs: ExpiredJob[] | null = null;
let fetchPromise: Promise<ExpiredJob[]> | null = null;

function fetchExpiredJobs(): Promise<ExpiredJob[]> {
 if (cachedExpiredJobs) return Promise.resolve(cachedExpiredJobs);
 if (!fetchPromise) {
 fetchPromise = fetch('/data/expired-jobs.json')
 .then((r) => r.json() as Promise<ExpiredJob[]>)
 .then((data) => {
 cachedExpiredJobs = data;
 return data;
 })
 .catch(() => {
 fetchPromise = null; // allow retry on next call
 return [] as ExpiredJob[];
 });
 }
 return fetchPromise;
}

function matchExpiredSlug(job: ExpiredJob, slug: string): boolean {
 if (job.slug === slug) return true;
 if (job.slugByLocale) {
 return Object.values(job.slugByLocale).some((s) => s === slug);
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

 // 2. Fall back to runtime JSON fetch (for SPA navigation to expired jobs)
 let cancelled = false;
 setLoading(true);
 fetchExpiredJobs().then((jobs) => {
 if (cancelled) return;
 const found = jobs.find((j) => matchExpiredSlug(j, slug)) ?? null;
 setExpiredJob(found);
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
