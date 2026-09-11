/**
 * Create the identity shared by every provider emission of one analytics act.
 *
 * This module deliberately has no browser or history dependency. A caller
 * that cannot determine an identity passes `null` to trackPageView; it must
 * never replace that absence with a guessed number.
 */
export function createAnalyticsEmissionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through to a local key when Web Crypto is unavailable.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
