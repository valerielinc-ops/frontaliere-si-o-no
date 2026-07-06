/**
 * Job Match Profile — localStorage store for survey-derived job-match signals.
 *
 * Captures sector / experience level / canton answered in SalarySurvey so the
 * job board can rank/filter offers against a real profile signal instead of
 * only behavior (viewed jobs / searches). Local-only, no Firestore sync:
 * this is a coarse ranking hint, not account data — keeps the surface small.
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
