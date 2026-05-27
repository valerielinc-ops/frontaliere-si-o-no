/**
 * Job-detail alert prompt — gating logic.
 *
 * Pure utility module: no React, no Firebase. Only reads/writes
 * `localStorage` under a single namespaced key.
 *
 * Rule (post-2026-05-19 relaxation):
 *   At most `DAILY_DISMISS_CAP` dismisses per local day. After the cap is
 *   reached the prompt is suppressed for the rest of that day; it resumes
 *   the following day. No 30-day cooldown, no per-category cooldown, no
 *   session-scoped suppression.
 *
 * Rationale: the previous gating (DISMISS_CAP=2 → 30d cooldown +
 * 7d per-category + 1×/session) produced only 4 `shown` events in 30 days
 * across all categories, starving the funnel of signal. The relaxed gate
 * still respects user intent (2 explicit dismisses in a day = stop nagging)
 * without erasing the surface for weeks.
 *
 * A successful accept also suppresses for the day to avoid re-prompting on
 * the same day the user just subscribed.
 */

import { normalizeKeyword } from './jobAlertService';

export const STORAGE_KEY = 'jobDetailAlertPromptState';

const DAILY_DISMISS_CAP = 2;

export interface JobDetailAlertPromptState {
  /** Local-date key (YYYY-MM-DD) the counter applies to. */
  dismissDay: string | null;
  /** How many dismisses (or accepts) happened on `dismissDay`. */
  dismissesToday: number;
}

const DEFAULT_STATE: JobDetailAlertPromptState = {
  dismissDay: null,
  dismissesToday: 0,
};

function cloneDefault(): JobDetailAlertPromptState {
  return { dismissDay: null, dismissesToday: 0 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function todayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Robust JSON-parse of the persisted state. Returns defaults if missing,
 * malformed, or the schema doesn't match. Never throws.
 *
 * Forward-migrates the legacy shape (`dismissCount` / `lastDismissAt` /
 * `perCategorySeenAt`) by discarding it — the user gets a fresh quota,
 * which is the desired outcome of the relaxation.
 */
export function loadGatingState(): JobDetailAlertPromptState {
  if (typeof localStorage === 'undefined') return cloneDefault();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return cloneDefault();
    const dismissDay =
      typeof parsed.dismissDay === 'string' && parsed.dismissDay.length > 0
        ? parsed.dismissDay
        : null;
    const dismissesToday =
      typeof parsed.dismissesToday === 'number' && Number.isFinite(parsed.dismissesToday)
        ? parsed.dismissesToday
        : 0;
    return { dismissDay, dismissesToday };
  } catch {
    return cloneDefault();
  }
}

/**
 * Persist the gating state. Silently no-op if `localStorage` is unavailable
 * (private mode, quota exceeded, etc.).
 */
export function saveGatingState(state: JobDetailAlertPromptState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/**
 * Decide whether the prompt should be shown for `normalizedCategory` at `now`,
 * given `state`. Returns `false` only when the user has already dismissed
 * `DAILY_DISMISS_CAP` times today.
 */
export function shouldShowPrompt(
  state: JobDetailAlertPromptState,
  now: Date,
  normalizedCategory: string,
): boolean {
  if (!normalizedCategory) return false;
  const today = todayKey(now);
  if (state.dismissDay === today && state.dismissesToday >= DAILY_DISMISS_CAP) {
    return false;
  }
  return true;
}

/**
 * Apply the side-effects for a "user dismissed the prompt" event.
 * Bumps the daily counter; rolls over the day when the date changes.
 * Returns a NEW state object (no mutation of the input).
 */
export function recordDismiss(
  state: JobDetailAlertPromptState,
  now: Date,
  _normalizedCategory: string,
): JobDetailAlertPromptState {
  const today = todayKey(now);
  if (state.dismissDay !== today) {
    return { dismissDay: today, dismissesToday: 1 };
  }
  return { dismissDay: today, dismissesToday: state.dismissesToday + 1 };
}

/**
 * Apply the side-effects for a successful "user accepted" event.
 * Suppresses further prompts for the rest of the day (counter pinned to cap).
 * Returns a NEW state object (no mutation of the input).
 */
export function recordAccept(
  state: JobDetailAlertPromptState,
  now: Date,
  _normalizedCategory: string,
): JobDetailAlertPromptState {
  return { dismissDay: todayKey(now), dismissesToday: DAILY_DISMISS_CAP };
}

/** Re-export for callers that already have the gating module imported. */
export { normalizeKeyword };

export const __testing = {
  DAILY_DISMISS_CAP,
  DEFAULT_STATE,
  todayKey,
};
