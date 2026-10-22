const PLATE_AUCTION_HOST_ALIASES = Object.freeze({
  'www.auktion.tg.ch': 'auktion.tg.ch',
});

/**
 * Source portals can move between equivalent host aliases without changing
 * the logical catalogue. Keep that migration out of identity comparisons and
 * public detail links while leaving unrelated source URLs untouched.
 */
export function normalizePlateAuctionUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    const canonicalHostname = PLATE_AUCTION_HOST_ALIASES[url.hostname.toLowerCase()];
    if (!canonicalHostname) return value;
    url.hostname = canonicalHostname;
    return url.toString();
  } catch {
    return value;
  }
}
