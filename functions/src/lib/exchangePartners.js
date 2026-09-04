/**
 * exchangePartners.js — SINGLE SOURCE of the CHF/EUR referral partner data.
 *
 * Canonical home is functions/src/lib/ (not services/) because
 * functions/src/lib/affiliatePartnersRegistry.js needs these referral URLs
 * at Cloud Functions runtime, and firebase.json's `source: "functions"`
 * means functions/src/** cannot import anything outside functions/ (no
 * bundler at deploy time — see affiliatePartnersRegistry.js's header).
 * services/exchangePartners.mjs re-exports this so every existing
 * services/scripts/test importer (services/exchangePartners.ts,
 * services/affiliatePartnersRegistry.mjs) keeps resolving to the exact same
 * module — no drift between the two call sites.
 *
 * Plain ESM (no TS types) so it loads in every runtime without a bundler.
 *
 * `typicalCostPct` is the indicative ALL-IN cost (spread + commission) shown in
 * static prose — deliberately coarse (marketing-stable) while the SPA computes
 * exact per-amount figures with its own fee model.
 */

export const WISE_REFERRAL_URL = 'https://wise.prf.hn/l/4PRMNMW/';
export const REVOLUT_REFERRAL_URL =
  'https://revolut.com/referral/?referral-code=luigi4mdv!FEB1-26-AR-H1&geo-redirect';
export const CAMBIAVALUTE_REFERRAL_URL = 'https://dashboard.cambiavalute.ch/r/28693';
export const FINECO_REFERRAL_URL = 'https://fineco.mobi/passaparola';
export const CREDIT_AGRICOLE_IT_REFERRAL_URL = 'https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A';

/**
 * The three low-cost partners promoted on the static exchange pages, ranked by
 * typical all-in cost. Traditional banks (2.5–3%+) are described in prose as
 * the comparison baseline, not listed here.
 */
export const EXCHANGE_REFERRAL_PARTNERS = [
  {
    name: 'Wise (TransferWise)',
    slug: 'wise',
    referralUrl: WISE_REFERRAL_URL,
    typicalCostPct: 0.3,
  },
  {
    name: 'Cambiavalute.ch',
    slug: 'cambiavalute',
    referralUrl: CAMBIAVALUTE_REFERRAL_URL,
    typicalCostPct: 0.35,
  },
  {
    name: 'Revolut',
    slug: 'revolut',
    referralUrl: REVOLUT_REFERRAL_URL,
    typicalCostPct: 0.5,
  },
];
