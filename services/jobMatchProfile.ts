/**
 * Job Match Profile — localStorage store for survey-derived job-match signals.
 *
 * Captures sector / experience level / canton answered in SalarySurvey so the
 * job board can rank/filter offers against a real profile signal instead of
 * only behavior (viewed jobs / searches). Local-only, no Firestore sync:
 * this is a coarse ranking hint, not account data — keeps the surface small.
 *
 * Issue #3648 also asks to fold in "preferenze newsletter" (the
 * newsletter_subscribers/{email} Firestore doc — sector_interest/job_category/
 * location_interest/geo_city, see services/jobAlertMatching.mjs) as a second
 * profile source for logged-in subscribers. That doc is fetched client-side
 * in JobBoard.tsx (public read, firestore.rules) and merged in here via
 * mergeNewsletterSignals — kept out of loadJobMatchProfile/saveJobMatchProfile
 * because it's per-session Firestore state, not something to persist locally.
 */

import { isStorageAvailable } from '@/services/storageAvailability';

const STORAGE_KEY = 'frontaliere_job_match_profile';

export interface JobMatchProfileData {
  version: 1;
  sector: string | null;
  experienceLevel: string | null;
  canton: string | null;
  updatedAt: number;
}

/** Read persisted job-match profile, or null when never saved / unavailable. */
export function loadJobMatchProfile(): JobMatchProfileData | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JobMatchProfileData;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist (partial-merge) sector / experienceLevel / canton signals. */
export function saveJobMatchProfile(
  partial: Partial<Pick<JobMatchProfileData, 'sector' | 'experienceLevel' | 'canton'>>,
): void {
  if (!isStorageAvailable()) return;
  try {
    const existing = loadJobMatchProfile();
    const next: JobMatchProfileData = {
      version: 1,
      sector: existing?.sector ?? null,
      experienceLevel: existing?.experienceLevel ?? null,
      canton: existing?.canton ?? null,
      ...partial,
      updatedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort — ranking falls back to unchanged order without a profile
  }
}

/**
 * Subset of the newsletter_subscribers/{email} Firestore doc relevant to
 * job-match ranking. sector_interest/job_category are already normalized to
 * JobCategory-shaped strings by the backfill pipeline (see
 * tests/backfill-personalization-sector.test.ts) in most cases, so they're
 * compared directly against job.category rather than through
 * SURVEY_SECTOR_TO_CATEGORY (that table is keyed on SalarySurvey's own
 * sector taxonomy, a different vocabulary). location_interest/geo_city are
 * free-text city names, not canton codes.
 */
export interface NewsletterProfileSignals {
  sector_interest?: string | null;
  job_category?: string | null;
  location_interest?: string | null;
  geo_city?: string | null;
}

/**
 * Merge newsletter-subscriber sector/location signals into a job-match
 * profile, filling gaps only: an explicit SalarySurvey answer always takes
 * priority over an inferred newsletter preference. Returns `base` unchanged
 * when there's nothing usable to merge (including when `base` is null and
 * the newsletter doc has no signal either).
 */
export function mergeNewsletterSignals(
  base: JobMatchProfileData | null,
  newsletter: NewsletterProfileSignals | null,
): JobMatchProfileData | null {
  if (!newsletter) return base;
  const newsletterSector = newsletter.sector_interest || newsletter.job_category || null;
  const newsletterLocation = newsletter.location_interest || newsletter.geo_city || null;
  if (!newsletterSector && !newsletterLocation) return base;
  if (base?.sector && base?.canton) return base; // nothing left to fill
  return {
    version: 1,
    sector: base?.sector ?? newsletterSector,
    experienceLevel: base?.experienceLevel ?? null,
    canton: base?.canton ?? newsletterLocation,
    updatedAt: base?.updatedAt ?? Date.now(),
  };
}
