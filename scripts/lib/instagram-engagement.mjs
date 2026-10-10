/**
 * Stable names for the action requested by each Instagram treatment.
 *
 * Keep this mapping shared by carousel and Reel ledgers so the scorecard can
 * compare the CTA mechanism independently from the format that rendered it.
 */
const ENGAGEMENT_MECHANIC_BY_METRIC = Object.freeze({
  comments: 'keyword-comment',
  shares: 'direct-share',
  saves: 'save-reminder',
});

export function instagramEngagementMechanic(primaryMetric) {
  return ENGAGEMENT_MECHANIC_BY_METRIC[String(primaryMetric || '').trim()] || 'unknown';
}
