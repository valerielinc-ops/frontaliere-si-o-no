/**
 * Shared CHF/EUR exchange partner registry — ONE definition for the referral
 * partners surfaced both by the SPA comparator
 * (components/comparators/CurrencyExchange.tsx) and by the static exchange
 * SSG pages (build-plugins/exchangeRatePagesPlugin.ts).
 *
 * Extracted per AGENTS.md Non-Negotiable #6: a referral URL duplicated
 * literally in ≥2 files WILL drift (a partner rotates the code, one copy gets
 * updated, the other keeps paying the old link). The data lives in
 * services/exchangePartners.mjs (plain ESM) so it is ALSO reachable from the
 * Node newsletter/drip senders (services/affiliatePartnersRegistry.mjs) which
 * cannot import a .ts. This module re-exports it with types applied.
 *
 * `typicalCostPct` is the indicative ALL-IN cost (spread + commission) shown
 * in static prose — kept deliberately coarse (marketing-stable) while the SPA
 * computes exact per-amount figures with its own fee model.
 */

import { EXCHANGE_REFERRAL_PARTNERS as EXCHANGE_REFERRAL_PARTNERS_DATA } from './exchangePartners.mjs';

export {
  WISE_REFERRAL_URL,
  REVOLUT_REFERRAL_URL,
  CAMBIAVALUTE_REFERRAL_URL,
  FINECO_REFERRAL_URL,
  CREDIT_AGRICOLE_IT_REFERRAL_URL,
} from './exchangePartners.mjs';

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

/**
 * The three low-cost partners promoted on the static exchange pages, ranked
 * by typical all-in cost. Traditional banks (2.5–3%+) are described in prose
 * as the comparison baseline, not listed here.
 */
export const EXCHANGE_REFERRAL_PARTNERS: readonly ExchangeReferralPartner[] =
  EXCHANGE_REFERRAL_PARTNERS_DATA as unknown as readonly ExchangeReferralPartner[];
