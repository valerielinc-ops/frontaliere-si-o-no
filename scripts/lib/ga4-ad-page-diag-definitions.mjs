/**
 * GA4 custom definitions for the `ad_page_diag` event (services/adPageDiag.ts).
 *
 * Every parameter of the event is listed exactly once below; the test
 * tests/ad-page-diag.test.ts requires the union to equal the parameter set the
 * collector emits, so a new parameter cannot ship unregistered (GA4 does not
 * backfill: a parameter registered late loses every event sent before).
 *
 * Event-scoped dimensions are scarce (50 per property, 46 in use on
 * 2026-09-28), so the event reuses three that already exist instead of
 * registering look-alikes:
 *   - page_template: registered for page_view; `ad_page_diag` sends its own
 *     ad-oriented taxonomy (services/adPageTemplate.ts), so filter on the
 *     event name when reading it;
 *   - consent_state, gate_status: registered by the Offerwall work (#10230),
 *     same values (granted|denied|none, held|released|suppressed|off_board|absent).
 * Every 0/1 flag is a metric, not a dimension: summed it is a count of page
 * views, divided by the event count it is a rate.
 */

/** Already registered in the property; reused, never created here. */
export const AD_PAGE_DIAG_GA4_SHARED_DIMENSIONS = Object.freeze(['page_template', 'consent_state', 'gate_status']);

export const AD_PAGE_DIAG_GA4_CUSTOM_DIMENSIONS = Object.freeze([
  Object.freeze({
    parameterName: 'ad_path',
    displayName: 'Ad Path',
    description: 'ad_page_diag: why the ad path ran or not (loaded, bot_gated, noads_entitlement, waiting_consent)',
  }),
  Object.freeze({
    parameterName: 'anchor_status',
    displayName: 'Ad Anchor Status',
    description: 'ad_page_diag: data-anchor-status of the Auto ads anchor at snapshot time, or none',
  }),
]);

function metric(parameterName, displayName, description, measurementUnit = 'STANDARD') {
  return Object.freeze({ parameterName, displayName, description: `ad_page_diag: ${description}`, measurementUnit });
}

export const AD_PAGE_DIAG_GA4_CUSTOM_METRICS = Object.freeze([
  metric('slots_total', 'Ad Diag Slots Total', 'manual AdSense slots in the page'),
  metric('slots_filled', 'Ad Diag Slots Filled', 'manual slots with data-ad-status=filled'),
  metric('slots_unfilled', 'Ad Diag Slots Unfilled', 'manual slots with data-ad-status=unfilled'),
  metric('slots_collapsed', 'Ad Diag Slots Collapsed', 'manual slots whose reserve was given back'),
  metric('auto_placed', 'Ad Diag Auto Placed', 'Auto ads .google-auto-placed containers'),
  metric('vignette_ready', 'Ad Diag Vignette Ready', '1 when an Auto ads vignette was loaded'),
  metric('first_fill_ms', 'Ad Diag First Fill ms', 'ms from page-view start to the first filled manual slot (-1 = none)', 'MILLISECONDS'),
  metric('cmp_shown', 'Ad Diag CMP Shown', '1 when the consent message appeared or the decision changed'),
  metric('ad_blocked', 'Ad Diag Ad Blocked', '1 when Funding Choices detected an ad blocker'),
  metric('diag_hidden', 'Ad Diag Sent On Hide', '1 when sent early on hide, pagehide or SPA navigation'),
  metric('adsbygoogle_loaded', 'Ad Diag AdSense Loaded', '1 when adsbygoogle.js had loaded'),
  metric('fc_loaded', 'Ad Diag FC Loaded', '1 when Funding Choices had loaded'),
]);
