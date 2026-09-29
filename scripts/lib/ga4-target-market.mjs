/**
 * GA4 target-market scope shared by revenue monitors.
 *
 * The site serves cross-border workers in Italy and Switzerland. Keeping this
 * filter in one module prevents daily and hourly revenue signals from using
 * different denominators when an unrelated bot fleet enters the property.
 */
export const TARGET_MARKET_COUNTRIES = Object.freeze(['Italy', 'Switzerland']);

export function buildTargetMarketCountryFilter() {
  return {
    filter: {
      fieldName: 'country',
      inListFilter: { values: [...TARGET_MARKET_COUNTRIES] },
    },
  };
}
