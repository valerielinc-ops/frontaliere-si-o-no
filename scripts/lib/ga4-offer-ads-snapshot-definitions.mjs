/**
 * GA4 custom metrics of the rewarded offer's ads snapshots
 * (services/adVisibilitySnapshot.ts, events rewarded_offer_ads_open /
 * _offerwall / _return). Registered by
 * scripts/setup-ga4-ad-page-diag-definitions.mjs together with the
 * ad_page_diag definitions.
 *
 * Metrics only: event-scoped dimensions are nearly exhausted (48 of 50 on
 * 2026-09-30), and the three moments are told apart by the event name.
 * tests/services/adVisibilitySnapshot.test.ts requires these names to equal
 * the keys collectAdVisibility() returns, so a new key cannot ship unregistered.
 */

function metric(parameterName, displayName, description) {
  return Object.freeze({ parameterName, displayName, description: `rewarded_offer_ads_*: ${description}`, measurementUnit: 'STANDARD' });
}

export const OFFER_ADS_SNAPSHOT_GA4_CUSTOM_METRICS = Object.freeze([
  metric('ads_total', 'Offer Ads Total', 'ads with a creative in the page (manual filled, Auto ads, anchor, GAM)'),
  metric('ads_visible', 'Offer Ads Visible', 'of ads_total, those still rendered (no display none, not invisible, not zero-sized)'),
  metric('anchor_visible', 'Offer Anchor Visible', '1 when the displayed Auto ads anchor is rendered'),
]);
