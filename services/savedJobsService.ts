/**
 * Saved Jobs — localStorage-first store for the job-board "Salvati" feature
 * (epic #4465, sub #4466/#4467).
 *
 * Zero login required: the list lives entirely in localStorage, mirroring
 * `services/jobMatchProfile.ts` (same storage-availability guard, same
 * versioned envelope). Each entry snapshots the minimal job fields needed to
 * (a) match saved ids against the loaded job pool for the "Salvati" filter and
 * (b) derive dominant category/canton for the alert nudge (#4467) even when
 * the underlying job has churned out of the dataset.
 *
 * Cross-component sync: every mutation dispatches SAVED_JOBS_CHANGED_EVENT on
 * `window` so any mounted consumer (list card, detail chip, filter pill
 * counter) can re-read without prop drilling through the 9k-line JobBoard.
 *
 * The nudge gating (threshold + dismiss cooldown) also lives here — modeled on
 * `services/jobDetailAlertGating.ts` (pure functions, immutable state,
 * defensive parsing) but with a durable N-day cooldown instead of a daily cap:
 * the nudge is a one-shot behavioral bridge (saved ≥2 → offer alert), not a
 * recurring surface.
 */

import { isStorageAvailable } from '@/services/storageAvailability';
import { CANTON_CODES } from '@/services/cantonList';

export const SAVED_JOBS_STORAGE_KEY = 'frontaliere_saved_jobs';
export const SAVED_JOBS_CHANGED_EVENT = 'frontaliere:saved-jobs-changed';

/** Max persisted entries — oldest dropped first. Keeps the envelope tiny. */
export const SAVED_JOBS_CAP = 100;

export interface SavedJobEntry {
  /** Stable job id (`JobListing.id`) — the match key against the loaded pool. */
  id: string;
  slug: string | null;
  title: string;
  company: string;
  canton: string | null;
  category: string | null;
  savedAt: number;
}

interface SavedJobsEnvelope {
  version: 1;
  jobs: SavedJobEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeEntry(raw: unknown): SavedJobEntry | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  return {
    id: raw.id,
    slug: typeof raw.slug === 'string' && raw.slug.length > 0 ? raw.slug : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    company: typeof raw.company === 'string' ? raw.company : '',
    canton: typeof raw.canton === 'string' && raw.canton.length > 0 ? raw.canton : null,
    category: typeof raw.category === 'string' && raw.category.length > 0 ? raw.category : null,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
  };
}

/** Read the persisted saved-jobs list (newest last). Empty array when unavailable. */
export function loadSavedJobs(): SavedJobEntry[] {
  if (!isStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(SAVED_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    const entries: SavedJobEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed.jobs) {
      const entry = sanitizeEntry(item);
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function persist(entries: SavedJobEntry[]): void {
  if (!isStorageAvailable()) return;
  try {
    const envelope: SavedJobsEnvelope = { version: 1, jobs: entries.slice(-SAVED_JOBS_CAP) };
    localStorage.setItem(SAVED_JOBS_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // best-effort — a full quota just means the save silently no-ops
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SAVED_JOBS_CHANGED_EVENT));
    }
  } catch {
    // ignore
  }
}

/** Whether a job id is currently saved. */
export function isJobSaved(jobId: string): boolean {
  if (!jobId) return false;
  return loadSavedJobs().some((entry) => entry.id === jobId);
}

/**
 * Toggle a job in the saved list. Returns the NEW saved state
 * (`true` = job is now saved, `false` = it was removed).
 */
export function toggleSavedJob(entry: Omit<SavedJobEntry, 'savedAt'>): boolean {
  const existing = loadSavedJobs();
  if (existing.some((e) => e.id === entry.id)) {
    persist(existing.filter((e) => e.id !== entry.id));
    return false;
  }
  persist([...existing, { ...entry, savedAt: Date.now() }]);
  return true;
}

// ── Alert-criteria derivation (#4467) ───────────────────────────────────────

export interface SavedJobsAlertCriteria {
  /** Dominant `JobCategory` key across saved jobs, or null when none usable. */
  category: string | null;
  /** Dominant canton as a validated 2-letter code, or null. */
  cantonCode: string | null;
}

/**
 * Majority vote over a field of the saved entries. Ties break toward the value
 * carried by the most recently saved entry (freshest intent wins).
 */
function dominantValue(
  entries: SavedJobEntry[],
  pick: (e: SavedJobEntry) => string | null,
): string | null {
  const counts = new Map<string, { count: number; lastSavedAt: number }>();
  for (const entry of entries) {
    const value = pick(entry);
    if (!value) continue;
    const bucket = counts.get(value) ?? { count: 0, lastSavedAt: 0 };
    bucket.count += 1;
    bucket.lastSavedAt = Math.max(bucket.lastSavedAt, entry.savedAt);
    counts.set(value, bucket);
  }
  let best: string | null = null;
  let bestCount = 0;
  let bestSavedAt = -1;
  for (const [value, { count, lastSavedAt }] of counts) {
    if (count > bestCount || (count === bestCount && lastSavedAt > bestSavedAt)) {
      best = value;
      bestCount = count;
      bestSavedAt = lastSavedAt;
    }
  }
  return best;
}

/**
 * Derive prefilled alert criteria from the saved list: dominant category and
 * dominant canton (only when it's a real 2-letter code — mirrors the
 * validation `JobBoard.tsx` applies to the job-match profile canton before
 * passing it to `subscribeJobAlertOneTap`).
 */
export function deriveSavedJobsAlertCriteria(entries: SavedJobEntry[]): SavedJobsAlertCriteria {
  const category = dominantValue(entries, (e) => e.category);
  const rawCanton = dominantValue(entries, (e) => e.canton);
  const upper = rawCanton ? rawCanton.trim().toUpperCase() : '';
  const cantonCode = upper && (CANTON_CODES as readonly string[]).includes(upper) ? upper : null;
  return { category, cantonCode };
}

// ── Nudge gating (#4467) ────────────────────────────────────────────────────

export const SAVED_JOBS_NUDGE_STORAGE_KEY = 'frontaliere_saved_jobs_nudge';
/** Minimum saved jobs before the alert nudge may show. */
export const SAVED_JOBS_NUDGE_THRESHOLD = 2;
/** After an explicit dismiss, stay quiet for this long. */
export const NUDGE_DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export interface SavedJobsNudgeState {
  /** Epoch ms of the last explicit dismiss, or null. */
  dismissedAt: number | null;
  /** Epoch ms of a successful accept — terminal, nudge never returns. */
  acceptedAt: number | null;
}

function defaultNudgeState(): SavedJobsNudgeState {
  return { dismissedAt: null, acceptedAt: null };
}

export function loadNudgeState(): SavedJobsNudgeState {
  if (!isStorageAvailable()) return defaultNudgeState();
  try {
    const raw = localStorage.getItem(SAVED_JOBS_NUDGE_STORAGE_KEY);
    if (!raw) return defaultNudgeState();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return defaultNudgeState();
    return {
      dismissedAt:
        typeof parsed.dismissedAt === 'number' && Number.isFinite(parsed.dismissedAt)
          ? parsed.dismissedAt
          : null,
      acceptedAt:
        typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt)
          ? parsed.acceptedAt
          : null,
    };
  } catch {
    return defaultNudgeState();
  }
}

export function saveNudgeState(state: SavedJobsNudgeState): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(SAVED_JOBS_NUDGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/**
 * Whether the alert nudge may show: threshold reached, never accepted, and
 * any previous dismiss older than the cooldown window.
 */
export function shouldShowSavedJobsNudge(
  savedCount: number,
  state: SavedJobsNudgeState,
  now: Date,
): boolean {
  if (savedCount < SAVED_JOBS_NUDGE_THRESHOLD) return false;
  if (state.acceptedAt !== null) return false;
  if (state.dismissedAt !== null && now.getTime() - state.dismissedAt < NUDGE_DISMISS_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/** Immutable state transition for an explicit dismiss. */
export function recordNudgeDismissed(state: SavedJobsNudgeState, now: Date): SavedJobsNudgeState {
  return { ...state, dismissedAt: now.getTime() };
}

/** Immutable state transition for a successful accept (terminal). */
export function recordNudgeAccepted(state: SavedJobsNudgeState, now: Date): SavedJobsNudgeState {
  return { ...state, acceptedAt: now.getTime() };
}
