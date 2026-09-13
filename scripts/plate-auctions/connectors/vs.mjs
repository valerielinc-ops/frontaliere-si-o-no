#!/usr/bin/env node
/**
 * Vallese (VS) eCari connector.
 *
 * The parser itself lives in functions/src/plateAuctionsCore.js and is shared
 * with the scheduled Cloud Function. This file supplies VS's source
 * configuration and keeps the historical named exports used by tests/CLI.
 */
import {
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
} from '../../../functions/src/plateAuctionsCore.js';

export const VS_CANTON = 'Vallese';
export const VS_PLATE_CODE = 'VS';
export const VS_AUCTION_URL = 'https://ecari.vs.ch/ecari-auction/';

const VS_TAB_SECTIONS = [
  { tabContentId: 'tabContent1', auctionStatus: 'active', listingType: 'auction', idPrefix: 'vs' },
  { tabContentId: 'tabContent2', auctionStatus: 'upcoming', listingType: 'future-registration', idPrefix: 'vs-future' },
  { tabContentId: 'tabContent4', auctionStatus: 'upcoming', listingType: 'wanted', idPrefix: 'vs-wanted' },
];

export function extractTabSection(html, tabContentId) {
  return extractEcariTabSection(html, tabContentId);
}

export function parseVsAuctionRows(
  html,
  { fetchedAt = new Date().toISOString(), auctionStatus = 'active', listingType = 'auction', idPrefix = 'vs' } = {},
) {
  return parseEcariAuctionRows(html, {
    canton: VS_CANTON,
    plateCode: VS_PLATE_CODE,
    officialAuctionUrl: VS_AUCTION_URL,
    fetchedAt,
    auctionStatus,
    listingType,
    idPrefix,
    detailUrlBuilder: () => VS_AUCTION_URL,
  });
}

export async function fetchVsPlateAuctions() {
  const html = await fetchHtml(VS_AUCTION_URL);
  const fetchedAt = new Date().toISOString();
  return VS_TAB_SECTIONS.flatMap(({ tabContentId, auctionStatus, listingType, idPrefix }) =>
    parseVsAuctionRows(extractTabSection(html, tabContentId), { fetchedAt, auctionStatus, listingType, idPrefix }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchVsPlateAuctions()
    .then((auctions) => {
      console.log(JSON.stringify(auctions, null, 2));
      console.log(`\n${auctions.length} VS plate auction(s)/listing(s) found across tab1/tab2/tab4.`);
    })
    .catch((error) => {
      console.error('VS plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
