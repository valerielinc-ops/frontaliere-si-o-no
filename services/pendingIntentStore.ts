/**
 * Generic localStorage-backed "pending intent" store with a TTL — survives
 * the auth round-trip across every sign-in surface, including a magic-link
 * email that opens in a brand-new tab (sessionStorage is per-tab and would
 * be lost there). Shared by pendingJobAlert.ts and pendingSaveJob.ts so the
 * TTL/expiry/storage-guard logic lives in one place instead of being
 * copy-pasted per intent type.
 */

interface StoredIntent<T> {
  value: T;
  savedAt: number;
}

export const DEFAULT_INTENT_TTL_MS = 15 * 60 * 1000;

/**
 * Persist `value` under `key`. Returns `true` only when the intent is actually
 * readable back from localStorage — a `false` means the auth round-trip would
 * come back to nothing, and the caller must not promise a replay (issue 9575).
 */
export function saveIntent<T>(key: string, value: T): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const payload: StoredIntent<T> = { value, savedAt: Date.now() };
    const serialized = JSON.stringify(payload);
    window.localStorage.setItem(key, serialized);
    // Read back: a storage shim that swallows writes (some embedded webviews,
    // a full quota handled without throwing) would otherwise report success
    // for an intent that the replay can never find.
    return window.localStorage.getItem(key) === serialized;
  } catch {
    /* localStorage unavailable (private mode / quota) — caller shows recovery */
    return false;
  }
}

function readValidIntent<T>(key: string, ttlMs: number): T | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredIntent<T>;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.value) return null;
    if (Date.now() - parsed.savedAt > ttlMs) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

/** Non-destructive read: returns the pending value without clearing it. */
export function peekIntent<T>(key: string, ttlMs: number = DEFAULT_INTENT_TTL_MS): T | null {
  if (typeof window === 'undefined') return null;
  return readValidIntent<T>(key, ttlMs);
}

/** Reads the pending value (if any, and not expired) and clears it. */
export function consumeIntent<T>(key: string, ttlMs: number = DEFAULT_INTENT_TTL_MS): T | null {
  if (typeof window === 'undefined') return null;
  const value = readValidIntent<T>(key, ttlMs);
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  return value;
}

export function clearIntent(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
