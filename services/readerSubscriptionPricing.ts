/**
 * Reader no-ads subscription pricing — pure, dependency-free.
 *
 * Separate domain from services/publisherPricing.ts: that file prices
 * publisher job-listing units (CHF 49/unit, CHF 299 Piano Azienda). This
 * file prices the reader-facing "no-ads" subscription (#3655, part 2/2 of
 * #2961) — a single flat CHF 2.99/month plan, no volume/discount tiers.
 *
 * Dependency-free so it can be imported from the SPA, the Stripe checkout
 * builder in functions/src/stripeReaderCore.js (via the deploy-boundary
 * mirror pattern, see functions/src/publisherPricingMirror.js), and tests
 * without pulling the config graph.
 */

/** Stable plan identifier stored in Stripe checkout metadata + Firestore. */
export const READER_NOADS_PLAN = 'reader_noads';

/** Flat monthly price of the reader no-ads subscription, in CHF. */
export const READER_NOADS_PRICE_CHF = 2.99;

/** ISO currency code for the reader subscription charge. */
export const READER_NOADS_CURRENCY = 'CHF';

/** Billing period length in days (Stripe subscription interval = monthly). */
export const READER_NOADS_BILLING_PERIOD_DAYS = 30;
