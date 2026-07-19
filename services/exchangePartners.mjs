/**
 * exchangePartners.mjs — SINGLE SOURCE of the CHF/EUR referral partner data.
 *
 * Plain ESM (no TS types) so it loads in BOTH runtimes without a bundler:
 *  - the SPA comparator / static SSG plugins / affiliateService.ts, via
 *    services/exchangePartners.ts which re-exports these with types applied;
 *  - the Node newsletter/drip senders, via
 *    services/affiliatePartnersRegistry.mjs, which pull the referral URLs for
 *    the shared partner records (AGENTS.md #6: a referral URL defined once, no
 *    drift, reachable from a plain-Node script that can't import the .ts).
 *
 * `typicalCostPct` is the indicative ALL-IN cost (spread + commission) shown in
 * static prose — deliberately coarse (marketing-stable) while the SPA computes
 * exact per-amount figures with its own fee model.
 */

export const WISE_REFERRAL_URL = 'https://wise.com/invite/ihpn/luigis147';
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
