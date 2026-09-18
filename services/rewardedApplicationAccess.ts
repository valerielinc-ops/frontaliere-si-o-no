/**
 * Legacy browser-scoped access reader kept for the migration from the custom
 * GPT rewarded flow. New grants are owned by Google's native Offerwall; this
 * reader only lets an entitlement already issued by the old flow expire
 * naturally instead of interrupting an in-progress session.
 */

export const REWARDED_APPLICATION_ACCESS_STORAGE_KEY = 'frontaliere_rewarded_application_access_v1';

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
