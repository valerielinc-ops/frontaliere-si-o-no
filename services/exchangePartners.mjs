/**
 * Shim — canonical module now lives at `functions/src/lib/exchangePartners.js`
 * because `functions/src/lib/affiliatePartnersRegistry.js` needs these
 * referral URLs at Cloud Functions runtime, and Cloud Functions have no
 * bundler and cannot import anything outside `functions/`. Re-exported here
 * so every existing `services/`/`scripts/`/test importer (services/exchangePartners.ts,
 * services/affiliatePartnersRegistry.mjs) keeps resolving to the exact same
 * module — no drift between the two call sites.
 */
export {
  WISE_REFERRAL_URL,
  REVOLUT_REFERRAL_URL,
  CAMBIAVALUTE_REFERRAL_URL,
  FINECO_REFERRAL_URL,
  CREDIT_AGRICOLE_IT_REFERRAL_URL,
  EXCHANGE_REFERRAL_PARTNERS,
} from '../functions/src/lib/exchangePartners.js';
