/**
 * Progressive profile/jobalert enrichment — gating logic.
 *
 * Pure utility module: no React, no Firebase. Only reads/writes
 * `localStorage` under a single namespaced key. Modeled directly on
 * `services/jobDetailAlertGating.ts` (same daily-dismiss-cap shape, same
 * proven cooldown constant — no new cooldown tuning needed).
 *
 * One question at a time, picked from `FIELD_REGISTRY` by weight, skipping
 * fields that are already answered or whose `dependsOn` isn't satisfied yet.
 * `appliesTo: 'alert'` fields are only offered when an active alert context
 * is passed in (`alertInput` non-null) — they ask nothing when the user
 * hasn't created an alert yet.
 */

const STORAGE_KEY = 'profileEnrichmentPromptState';

const DAILY_DISMISS_CAP = 2;

export interface ProfileEnrichmentPromptState {
  /** Local-date key (YYYY-MM-DD) the counter applies to. */
  dismissDay: string | null;
  /** How many dismisses (or answers) happened on `dismissDay`. */
  dismissesToday: number;
}

/** Minimal profile shape the engine reads — decoupled from `UserProfileData`. */
export interface EnrichmentProfileInput {
  municipality?: string | null;
  frontaliereType?: string | null;
  workPosition?: string | null;
  /** Stored as a numeric string throughout the codebase (`UserProfileData.grossSalary`), never a number. */
  grossSalary?: string | null;
}

/** Minimal alert shape the engine reads — decoupled from `JobAlertConfig`. */
export interface EnrichmentAlertInput {
  cantonFilter?: string[] | null;
  sectors?: string[] | null;
}

export type EnrichmentFieldKey =
  | 'provinceQuickPick'
  | 'frontaliereType'
  | 'workPosition'
  | 'grossSalary'
  | 'cantonFilter'
  | 'sectors';

interface EnrichmentFieldDef {
  key: EnrichmentFieldKey;
  appliesTo: 'profile' | 'alert';
  weight: number;
  dependsOn?: readonly EnrichmentFieldKey[];
  isAnswered: (profile: EnrichmentProfileInput, alert: EnrichmentAlertInput | null) => boolean;
}

const hasText = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;
const hasItems = (value: unknown[] | null | undefined): boolean => Array.isArray(value) && value.length > 0;

/**
 * Ordered by `weight` descending (profile fields first — filling the profile
 * benefits every future alert, not just the current one).
 */
export const FIELD_REGISTRY: readonly EnrichmentFieldDef[] = [
  {
    key: 'provinceQuickPick',
    appliesTo: 'profile',
    weight: 100,
    isAnswered: (profile) => hasText(profile.municipality),
  },
  {
    key: 'frontaliereType',
    appliesTo: 'profile',
    weight: 90,
    isAnswered: (profile) => hasText(profile.frontaliereType),
  },
  {
    key: 'workPosition',
    appliesTo: 'profile',
    weight: 80,
    isAnswered: (profile) => hasText(profile.workPosition),
  },
  {
    key: 'grossSalary',
    appliesTo: 'profile',
    weight: 70,
    isAnswered: (profile) => hasText(profile.grossSalary),
  },
  {
    key: 'cantonFilter',
    appliesTo: 'alert',
    weight: 60,
    dependsOn: ['provinceQuickPick'],
    isAnswered: (_profile, alert) => hasItems(alert?.cantonFilter),
  },
  {
    key: 'sectors',
    appliesTo: 'alert',
    weight: 50,
    isAnswered: (_profile, alert) => hasItems(alert?.sectors),
  },
];

function cloneDefault(): ProfileEnrichmentPromptState {
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
 */
export function loadGatingState(): ProfileEnrichmentPromptState {
  if (typeof localStorage === 'undefined') return cloneDefault();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return cloneDefault();
    const dismissDay =
      typeof parsed.dismissDay === 'string' && parsed.dismissDay.length > 0 ? parsed.dismissDay : null;
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
export function saveGatingState(state: ProfileEnrichmentPromptState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function isDailyCapReached(state: ProfileEnrichmentPromptState, now: Date): boolean {
  const today = todayKey(now);
  return state.dismissDay === today && state.dismissesToday >= DAILY_DISMISS_CAP;
}

/**
 * Pick the next field to ask about, or `null` if the daily cap is reached or
 * every field the current context can offer is already answered.
 *
 * `alertInput` is `null` when there is no active alert context (e.g. the
 * user hasn't created one yet) — `appliesTo: 'alert'` fields are skipped.
 */
export function pickNextQuestion(
  profile: EnrichmentProfileInput,
  alert: EnrichmentAlertInput | null,
  state: ProfileEnrichmentPromptState,
  now: Date,
): EnrichmentFieldKey | null {
  if (isDailyCapReached(state, now)) return null;

  const answered = new Set(
    FIELD_REGISTRY.filter((field) => field.isAnswered(profile, alert)).map((field) => field.key),
  );

  const candidates = FIELD_REGISTRY.filter((field) => {
    if (answered.has(field.key)) return false;
    if (field.appliesTo === 'alert' && !alert) return false;
    if (field.dependsOn && !field.dependsOn.every((dep) => answered.has(dep))) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  return candidates.reduce((best, field) => (field.weight > best.weight ? field : best)).key;
}

/**
 * Apply the side-effects for a "user skipped/dismissed the prompt" event.
 * Bumps the daily counter; rolls over the day when the date changes.
 * Returns a NEW state object (no mutation of the input).
 */
export function recordSkip(state: ProfileEnrichmentPromptState, now: Date): ProfileEnrichmentPromptState {
  const today = todayKey(now);
  if (state.dismissDay !== today) {
    return { dismissDay: today, dismissesToday: 1 };
  }
  return { dismissDay: today, dismissesToday: state.dismissesToday + 1 };
}

/**
 * Apply the side-effects for a successful "user answered" event.
 * Suppresses further prompts for the rest of the day (counter pinned to cap),
 * same as `jobDetailAlertGating.recordAccept` — avoids re-nagging the same
 * day the user just engaged.
 * Returns a NEW state object (no mutation of the input).
 */
export function recordAnswer(state: ProfileEnrichmentPromptState, now: Date): ProfileEnrichmentPromptState {
  return { dismissDay: todayKey(now), dismissesToday: DAILY_DISMISS_CAP };
}

export const __testing = {
  STORAGE_KEY,
  DAILY_DISMISS_CAP,
  todayKey,
};
