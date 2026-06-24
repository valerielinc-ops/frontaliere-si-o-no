/**
 * prebidConfig — declarative Prebid.js demand config for the explicit GAM/GPT
 * slots (article rails, PoC). Header bidding only augments these GPT pubads
 * slots; it NEVER touches AdSense Auto Ads (~95% revenue), the same boundary
 * GptAdSlot already keeps. See docs/HEADER-BIDDING.md.
 *
 * Bidder placement IDs are intentionally NOT hardcoded: they are per-SSP account
 * identifiers, differ per ad unit, and must never live in the repo. They are
 * injected at build time via the `VITE_PREBID_CONFIG` env var — a JSON object
 * mapping each GAM ad unit path to its Prebid bids, e.g.:
 *
 *   VITE_PREBID_CONFIG='{"/23355151813/article-rail-left":[
 *     {"bidder":"criteo","params":{"networkId":12345}},
 *     {"bidder":"sovrn","params":{"tagid":"998877"}},
 *     {"bidder":"medianet","params":{"cid":"8CU...","crid":"45678"}}
 *   ]}'
 *
 * Unset / empty / malformed → empty map → `requestHeaderBids()` is a no-op that
 * resolves instantly, so GPT serves AdSense-only exactly as today. This keeps
 * the whole header-bidding stack inert until real SSP accounts and the matching
 * GAM line items exist — safe to merge with no behaviour change.
 */

export interface PrebidBid {
  /** Prebid bidder code, e.g. 'criteo', 'sovrn', 'medianet', 'yieldlab'. */
  bidder: string;
  /** Bidder-specific placement params (shape varies per SSP). */
  params: Record<string, unknown>;
}

export type PrebidConfigMap = Readonly<Record<string, readonly PrebidBid[]>>;

function parsePrebidConfig(raw: string | undefined): PrebidConfigMap {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, PrebidBid[]> = {};
    for (const [adUnitPath, bids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(bids)) continue;
      const valid = bids.filter(
        (b): b is PrebidBid =>
          !!b &&
          typeof b === 'object' &&
          typeof (b as { bidder?: unknown }).bidder === 'string' &&
          !!(b as { params?: unknown }).params &&
          typeof (b as { params?: unknown }).params === 'object',
      );
      if (valid.length) out[adUnitPath] = valid;
    }
    return out;
  } catch {
    // Build-time trusted input, but never let a malformed string break the SPA.
    return {};
  }
}

const PREBID_CONFIG: PrebidConfigMap = parsePrebidConfig(
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_PREBID_CONFIG,
);

/** Bids configured for a given GAM ad unit path (empty array if none). */
export function bidsForAdUnit(adUnitPath: string): readonly PrebidBid[] {
  return PREBID_CONFIG[adUnitPath] ?? [];
}

/** True when at least one ad unit has bidders configured via env. */
export function hasConfiguredBidders(): boolean {
  return Object.keys(PREBID_CONFIG).length > 0;
}
