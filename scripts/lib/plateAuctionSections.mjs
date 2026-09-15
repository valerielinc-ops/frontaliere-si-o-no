/**
 * Canonical static sections for the plate-auction data vertical.
 *
 * These pages are records built from a public auction snapshot: their
 * page-specific payload is deliberately numeric (plate, price, bid count and
 * date). Keep this matcher separate from the broader job-board classifier so
 * information-gain can exclude data-driven records without changing the
 * scope of unrelated SEO audits.
 */

export const PLATE_AUCTION_BASE_BY_LOCALE = Object.freeze({
  it: 'aste-targhe-svizzera',
  en: 'swiss-plate-auctions',
  de: 'schweizer-nummernschildauktionen',
  fr: 'encheres-plaques-suisses',
});

const PLATE_AUCTION_SECTION_SOURCE = Object.entries(PLATE_AUCTION_BASE_BY_LOCALE)
  .map(([locale, slug]) => (locale === 'it' ? slug : `${locale}/${slug}`))
  .join('|');

/**
 * Matches a canonical plate-auction section in a dist-relative path.
 * Accepts an optional leading slash for callers that already hold a URL path.
 */
export const PLATE_AUCTION_SECTION_RX = new RegExp(
  `^/?(?:${PLATE_AUCTION_SECTION_SOURCE})(?:/|$)`,
);

/**
 * @param {string} auctionSectionPath dist-relative path or URL path
 * @returns {boolean} whether the path belongs to the plate-auction vertical
 */
export function isPlateAuctionSectionPath(auctionSectionPath) {
  return PLATE_AUCTION_SECTION_RX.test(String(auctionSectionPath));
}
