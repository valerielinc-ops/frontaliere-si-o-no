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

  return { expiredJob, loading };
}
