/**
 * Job-detail alert prompt — gating logic.
 *
 * Pure utility module: no React, no Firebase. Only reads/writes
 * `localStorage` under a single namespaced key, plus a `sessionStorage`
 * "shown this session" flag.
 *
 * Decision is split across three rules:
 *   1. Session check — never re-show within the same browser session.
 *   2. Persistent dismiss cap — at most 2 dismisses lifetime, OR a 30-day
 *      cooldown if the cap is reached.
 *   3. Per-category cooldown — at least 7 days between shows for the same
 *      normalized category label.
 */

import { normalizeKeyword } from './jobAlertService';

export const STORAGE_KEY = 'jobDetailAlertPromptState';
export const SESSION_KEY = 'jobDetailAlertPromptShownThisSession';

const DISMISS_CAP = 2;
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PER_CATEGORY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface JobDetailAlertPromptState {
  /** Total lifetime "Non ora" / ✕ presses. */
  dismissCount: number;
  /** ISO timestamp of last dismiss; null if never dismissed. */
  lastDismissAt: string | null;
  /** Map: normalized-category → ISO timestamp when it was last shown. */
  perCategorySeenAt: Record<string, string>;
}

const DEFAULT_STATE: JobDetailAlertPromptState = {
  dismissCount: 0,
  lastDismissAt: null,
  perCategorySeenAt: {},
};

function cloneDefault(): JobDetailAlertPromptState {
  return {
    dismissCount: 0,
    lastDismissAt: null,
    perCategorySeenAt: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Robust JSON-parse of the persisted state. Returns defaults if missing,
 * malformed, or the schema doesn't match. Never throws.
 */
export function loadGatingState(): JobDetailAlertPromptState {
  if (typeof localStorage === 'undefined') return cloneDefault();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return cloneDefault();
    const dismissCount =
      typeof parsed.dismissCount === 'number' && Number.isFinite(parsed.dismissCount)
        ? parsed.dismissCount
        : 0;
    const lastDismissAt =
      typeof parsed.lastDismissAt === 'string' && parsed.lastDismissAt.length > 0
        ? parsed.lastDismissAt
        : null;
    const perCategoryRaw = isPlainObject(parsed.perCategorySeenAt)
      ? parsed.perCategorySeenAt
      : {};
    const perCategorySeenAt: Record<string, string> = {};
    for (const [k, v] of Object.entries(perCategoryRaw)) {
      if (typeof v === 'string' && v.length > 0) perCategorySeenAt[k] = v;
    }
    return { dismissCount, lastDismissAt, perCategorySeenAt };
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

function isSessionMarked(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Mark the prompt as "shown" for the current browser session. Cleared
 * automatically when the tab/window is closed.
 */
export function markShownThisSession(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // ignore
  }
}

/**
 * Decide whether the prompt should be shown for `normalizedCategory` at `now`,
 * given `state`. Returns `false` if any of the three rules trip; returns
 * `true` only if all checks pass and `normalizedCategory` is non-empty.
 */
export function shouldShowPrompt(
  state: JobDetailAlertPromptState,
  now: Date,
  normalizedCategory: string,
): boolean {
  if (!normalizedCategory) return false;
  if (isSessionMarked()) return false;

  const nowMs = now.getTime();

  // Rule 2: persistent dismiss cap.
  if (state.dismissCount >= DISMISS_CAP) {
    const lastMs = state.lastDismissAt ? new Date(state.lastDismissAt).getTime() : 0;
    if (Number.isFinite(lastMs) && nowMs - lastMs <= DISMISS_COOLDOWN_MS) {
      return false;
    }
  }

  // Rule 3: per-category cooldown.
  const seenIso = state.perCategorySeenAt[normalizedCategory];
  if (seenIso) {
    const seenMs = new Date(seenIso).getTime();
    if (Number.isFinite(seenMs) && nowMs - seenMs <= PER_CATEGORY_COOLDOWN_MS) {
      return false;
    }
  }

  return true;
}

/**
 * Apply the side-effects for a "user dismissed the prompt" event.
 *  - bump `dismissCount`
 *  - set `lastDismissAt = now`
 *  - record `perCategorySeenAt[category] = now`
 *
 * Returns a NEW state object (no mutation of the input).
 */
export function recordDismiss(
  state: JobDetailAlertPromptState,
  now: Date,
  normalizedCategory: string,
): JobDetailAlertPromptState {
  const iso = now.toISOString();
  return {
    dismissCount: state.dismissCount + 1,
    lastDismissAt: iso,
    perCategorySeenAt: normalizedCategory
      ? { ...state.perCategorySeenAt, [normalizedCategory]: iso }
      : { ...state.perCategorySeenAt },
  };
}

/**
 * Apply the side-effects for a successful "user accepted" event.
 *  - leave `dismissCount` and `lastDismissAt` untouched
 *  - record `perCategorySeenAt[category] = now`
 *
 * Returns a NEW state object (no mutation of the input).
 */
export function recordAccept(
  state: JobDetailAlertPromptState,
  now: Date,
  normalizedCategory: string,
): JobDetailAlertPromptState {
  const iso = now.toISOString();
  return {
    dismissCount: state.dismissCount,
    lastDismissAt: state.lastDismissAt,
    perCategorySeenAt: normalizedCategory
      ? { ...state.perCategorySeenAt, [normalizedCategory]: iso }
      : { ...state.perCategorySeenAt },
  };
}

/** Re-export for callers that already have the gating module imported. */
export { normalizeKeyword };

export const __testing = {
  DISMISS_CAP,
  DISMISS_COOLDOWN_MS,
  PER_CATEGORY_COOLDOWN_MS,
  DEFAULT_STATE,
};
