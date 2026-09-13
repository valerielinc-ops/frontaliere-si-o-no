#!/usr/bin/env node
/** Grigioni eAuction/eCari connector. */
import {
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
} from '../../../functions/src/plateAuctionsCore.js';

export const GR_CANTON = 'Grigioni';
export const GR_PLATE_CODE = 'GR';
export const GR_AUCTION_URL = 'https://eauktion.gr.ch/';

export function parseGrAuctionRows(html, { fetchedAt = new Date().toISOString() } = {}) {
  const tabs = [
    ['tabContent1', 'active', 'auction', 'gr'],
    ['tabContent2', 'upcoming', 'future-registration', 'gr-future'],
    ['tabContent3', 'active', 'fixed-price', 'gr-fixed'],
    ['tabContent4', 'upcoming', 'wanted', 'gr-wanted'],
  ];
  return tabs.flatMap(([tab, auctionStatus, listingType, idPrefix]) => parseEcariAuctionRows(
    extractEcariTabSection(html, tab),
    {
      canton: GR_CANTON,
      plateCode: GR_PLATE_CODE,
      officialAuctionUrl: GR_AUCTION_URL,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix,
      detailUrlBuilder: () => GR_AUCTION_URL,
    },
  ));
}

export async function fetchGrPlateAuctions() {
  const html = await fetchHtml(GR_AUCTION_URL);
  return parseGrAuctionRows(html, { fetchedAt: new Date().toISOString() });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchGrPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error('GR plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
