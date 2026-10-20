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

/** URL-bound historical detail payload retained through client hydration. */
export const PLATE_AUCTION_DETAIL_SEED_ID = 'plate-auction-detail-seed';

/** An attested past asking price is neither a current offer nor a sale. */
export function isRecoveredPlateObservation(row) {
  return row?.auctionStatus === 'unknown' && row.listingType === 'fixed-price'
    && row.sourceCategory === 'fixed-price-api-recovery'
    && Number.isFinite(Date.parse(row.lastSeenAt || ''))
    && Number.isFinite(Date.parse(row.sourceFetchedAt || ''))
    && typeof row.startingPriceChf === 'number' && Number.isFinite(row.startingPriceChf) && row.startingPriceChf >= 0
    && row.currentBidChf === undefined && row.bidCount === undefined
    && row.endsAt === undefined && row.closedAt === undefined
    && row.finalPriceChf === undefined && row.finalPriceVerifiedAt === undefined;
}

const OBSERVATION_NOTICE = {
  it: date => `Osservazione storica del ${date}: il prezzo è quello richiesto nell'ultima lettura della fonte. Disponibilità attuale e vendita non confermate.`,
  en: date => `Historical observation from ${date}: this is the asking price at the last source reading. Current availability and sale are not confirmed.`,
  de: date => `Historische Beobachtung vom ${date}: Dies ist der zuletzt gelesene Angebotspreis der Quelle. Aktuelle Verfügbarkeit und Verkauf sind nicht bestätigt.`,
  fr: date => `Observation historique du ${date} : il s'agit du prix demandé lors de la dernière lecture de la source. La disponibilité actuelle et la vente ne sont pas confirmées.`,
};

export function recoveredPlateObservationNotice(row, locale) {
  if (!isRecoveredPlateObservation(row)) return '';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'Europe/Zurich' }).format(new Date(row.lastSeenAt));
  return OBSERVATION_NOTICE[locale](date);
}

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
