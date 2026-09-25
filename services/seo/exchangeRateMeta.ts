/**
 * Live CHF→EUR reference rate for SEO metadata (epic #4452 sibling fix).
 *
 * services/seo/seo-pages.ts used to hard-code `"price": "0.94"` in the
 * exchange comparator's ExchangeRateSpecification JSON-LD — stale by ~15%
 * (actual mid-market rate 2026: ~1.08) and unmaintainable by construction.
 *
 * ONE definition, sourced from the committed daily snapshot
 * (data/exchange-rate-snapshot.json, refreshed by update-exchange-history.yml):
 *   - runtime SPA: seo-pages.ts imports this constant directly
 *   - build time: build-plugins/shared/jsToJson.ts substitutes the bare
 *     `EXCHANGE_RATE_EUR` identifier inside structuredData literals with this
 *     value, so staticPagesPlugin's regex-parse → JSON.parse path keeps
 *     emitting the JSON-LD on the static page.
 *
 * Browser-safe: plain JSON import, no node builtins.
 */

import exchangeSnapshot from '../../data/exchange-rate-snapshot.json';

/** Current 1 CHF → EUR mid-market rate as a JSON-LD-ready string, e.g. "1.081". */
export const EXCHANGE_RATE_EUR: string = String(
  (exchangeSnapshot as { currentRate?: number }).currentRate ?? 1.08,
);
