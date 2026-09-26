/**
 * Browser-scoped entitlement issued after a rewarded grant (the AdSense
 * Offerwall's reward or a direct GPT Rewarded Web grant). The value contains
 * no account, job, or destination data and expires after one hour, the same
 * reward entitlement the AdSense Offerwall message grants (owner decision
 * 2026-09-26: a video on almost every application click).
 */

export const REWARDED_APPLICATION_ACCESS_STORAGE_KEY = 'frontaliere_rewarded_application_access_v1';
export const REWARDED_APPLICATION_ACCESS_TTL_MS = 60 * 60 * 1000;
/** The TTL in hours, for analytics (`access_ttl_hours`) and visible copy. */
export const REWARDED_APPLICATION_ACCESS_TTL_HOURS = REWARDED_APPLICATION_ACCESS_TTL_MS / (60 * 60 * 1000);

/**
 * Return the active entitlement expiry, or `null` when it is absent/expired.
 *
 * An expiry further away than one TTL was written under an older, longer TTL
 * (twelve hours until 2026-09-26): it is shortened to `now + TTL` and stored
 * back, so no grant outlives the current reward window.
 */
export function getRewardedApplicationAccessExpiresAt(now = Date.now()): number | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY);
    if (!raw) return null;
    const expiresAt = Number(raw);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      window.localStorage.removeItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY);
      return null;
    }
    const latestAllowed = now + REWARDED_APPLICATION_ACCESS_TTL_MS;
    if (expiresAt > latestAllowed) {
      window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(latestAllowed));
      return latestAllowed;
    }
    return expiresAt;
  } catch {
    return null;
  }
}

export function hasRewardedApplicationAccess(now = Date.now()): boolean {
  return getRewardedApplicationAccessExpiresAt(now) !== null;
}

/** Persist a fresh one-TTL entitlement and return its expiry timestamp. */
export function grantRewardedApplicationAccess(now = Date.now()): number {
  const expiresAt = now + REWARDED_APPLICATION_ACCESS_TTL_MS;
  if (typeof window === 'undefined') return expiresAt;

  try {
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(expiresAt));
  } catch {
    // The current navigation can still proceed; a later click will fall back
    // to the normal offer when storage is unavailable.
  }
  return expiresAt;
}

/** Test/support helper: remove the local browser entitlement. */
export function clearRewardedApplicationAccess(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the next successful read will remain fail-safe.
  }
}
