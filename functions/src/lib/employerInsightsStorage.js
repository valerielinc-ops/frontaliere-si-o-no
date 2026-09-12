/**
 * Shared Firestore collection names for employer-insights ad shards.
 *
 * The refresh script and the token-gated Cloud Function must agree on these
 * names. Keeping the small storage contract here avoids a writer/reader drift
 * when an additional report window is added.
 */

export const EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION = 'ads';
export const EMPLOYER_INSIGHTS_WINDOW_ADS_SUBCOLLECTION_PREFIX = 'ads_';

const WINDOW_KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/** Return the subcollection used for the ads of one additional window. */
export function employerInsightsWindowAdsSubcollection(windowKey) {
  const normalized = String(windowKey || '').trim().toLowerCase();
  if (!WINDOW_KEY_RE.test(normalized)) {
    throw new Error(`invalid employer insights window key: ${windowKey}`);
  }
  return `${EMPLOYER_INSIGHTS_WINDOW_ADS_SUBCOLLECTION_PREFIX}${normalized}`;
}

/** Recognize only collections that can belong to an additional report window. */
export function isEmployerInsightsWindowAdsSubcollection(collectionName) {
  const value = String(collectionName || '');
  return value.startsWith(EMPLOYER_INSIGHTS_WINDOW_ADS_SUBCOLLECTION_PREFIX)
    && WINDOW_KEY_RE.test(value.slice(EMPLOYER_INSIGHTS_WINDOW_ADS_SUBCOLLECTION_PREFIX.length));
}
