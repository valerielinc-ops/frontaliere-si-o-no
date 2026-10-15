/**
 * GA4 target-market scope shared by revenue monitors.
 *
 * The site serves cross-border workers in Italy and Switzerland. Keeping this
 * filter in one module prevents daily and hourly revenue signals from using
 * different denominators when an unrelated bot fleet enters the property.
 */
export const TARGET_MARKET_COUNTRIES = Object.freeze(['Italy', 'Switzerland']);

/**
 * The production `hostName` GA4 reports are scoped to. It lives here, in a
 * module with no imports, so a monitor that needs only the scope does not pull
 * the page classifiers of ga4-traffic-quality.mjs into its checkout profile.
 */
export const TRAFFIC_HOSTNAME = 'frontaliereticino.ch';

export function buildTargetMarketCountryFilter() {
  return {
    filter: {
      fieldName: 'country',
      inListFilter: { values: [...TARGET_MARKET_COUNTRIES] },
    },
  };
}
