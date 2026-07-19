/**
 * Shared CHF/EUR exchange partner registry — ONE definition for the referral
 * partners surfaced both by the SPA comparator
 * (components/comparators/CurrencyExchange.tsx) and by the static exchange
 * SSG pages (build-plugins/exchangeRatePagesPlugin.ts).
 *
 * Extracted per AGENTS.md Non-Negotiable #6: a referral URL duplicated
 * literally in ≥2 files WILL drift (a partner rotates the code, one copy gets
 * updated, the other keeps paying the old link). Both consumers import from
 * here so drift is impossible by construction.
 *
 * `typicalCostPct` is the indicative ALL-IN cost (spread + commission) shown
 * in static prose — kept deliberately coarse (marketing-stable) while the SPA
 * computes exact per-amount figures with its own fee model.
 */

export interface ExchangeReferralPartner {
  /** Display name (never translated — brand). */
  readonly name: string;
  /** Stable slug (matches CurrencyExchange.tsx provider slugs). */
  readonly slug: string;
  /** Referral URL (affiliate). */
  readonly referralUrl: string;
  /** Indicative all-in cost as percentage of the converted amount. */
  readonly typicalCostPct: number;
}

export const WISE_REFERRAL_URL = 'https://wise.com/invite/ihpn/luigis147';
export const REVOLUT_REFERRAL_URL =
  'https://revolut.com/referral/?referral-code=luigi4mdv!FEB1-26-AR-H1&geo-redirect';
export const CAMBIAVALUTE_REFERRAL_URL = 'https://dashboard.cambiavalute.ch/r/28693';
export const FINECO_REFERRAL_URL = 'https://fineco.mobi/passaparola';
export const CREDIT_AGRICOLE_IT_REFERRAL_URL = 'https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A';

/**
 * The three low-cost partners promoted on the static exchange pages, ranked
 * by typical all-in cost. Traditional banks (2.5–3%+) are described in prose
 * as the comparison baseline, not listed here.
 */
export const EXCHANGE_REFERRAL_PARTNERS: readonly ExchangeReferralPartner[] = [
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
