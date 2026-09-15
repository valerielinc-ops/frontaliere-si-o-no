/**
 * Canonical static sections for the plate-auction data vertical.
 *
 * These pages are records built from a public auction snapshot: their
 * page-specific payload is deliberately numeric (plate, price, bid count and
 * date). Keep this matcher separate from the broader job-board classifier so
 * information-gain can exclude data-driven records without changing the
 * scope of unrelated SEO audits.
 */

const PLATE_AUCTION_SECTION_SOURCE = [
  'aste-targhe-svizzera',
  'en/swiss-plate-auctions',
  'de/schweizer-nummernschildauktionen',
  'fr/encheres-plaques-suisses',
].join('|');

/**
 * Matches a canonical plate-auction section in a dist-relative path.
 * Accepts an optional leading slash for callers that already hold a URL path.
 */
export const PLATE_AUCTION_SECTION_RX = new RegExp(
  `^/?(?:${PLATE_AUCTION_SECTION_SOURCE})(?:/|$)`,
);

/**
 * @param {string} normalisedPath dist-relative path or URL path
 * @returns {boolean} whether the path belongs to the plate-auction vertical
 */
export function isPlateAuctionSectionPath(normalisedPath) {
  return PLATE_AUCTION_SECTION_RX.test(String(normalisedPath));
}
