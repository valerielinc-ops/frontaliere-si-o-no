/**
 * Browser-scoped access granted by the assisted-application rewarded ad.
 *
 * The value is deliberately only an expiry timestamp: it contains no account,
 * job, or destination data and expires twelve hours after the reward.
 */

export const REWARDED_APPLICATION_ACCESS_STORAGE_KEY = 'frontaliere_rewarded_application_access_v1';
export const REWARDED_APPLICATION_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

/** Return the active entitlement expiry, or `null` when it is absent/expired. */
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
    return expiresAt;
  } catch {
    return null;
  }
}

export function hasRewardedApplicationAccess(now = Date.now()): boolean {
  return getRewardedApplicationAccessExpiresAt(now) !== null;
}

/** Persist a fresh twelve-hour entitlement and return its expiry timestamp. */
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
