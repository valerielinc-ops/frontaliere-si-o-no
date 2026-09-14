#!/usr/bin/env node
/** Ticino eCari connector. The institutional page points to this public portal. */
import {
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
} from '../../../functions/src/plateAuctionsCore.js';

export const TI_CANTON = 'Ticino';
export const TI_PLATE_CODE = 'TI';
export const TI_AUCTION_URL = 'https://www.carieauktion.ti.ch/ecari-auktion/';

const TI_TAB_SECTIONS = [
  { tabContentId: 'tabContent1', auctionStatus: 'active', listingType: 'auction', idPrefix: 'ti' },
  { tabContentId: 'tabContent2', auctionStatus: 'upcoming', listingType: 'future-registration', idPrefix: 'ti-future' },
  { tabContentId: 'tabContent3', auctionStatus: 'active', listingType: 'fixed-price', idPrefix: 'ti-fixed' },
  { tabContentId: 'tabContent4', auctionStatus: 'upcoming', listingType: 'wanted', idPrefix: 'ti-wanted' },
];

export function extractTabSection(html, tabContentId) {
  return extractEcariTabSection(html, tabContentId);
}

export function parseTiAuctionRows(html, { fetchedAt = new Date().toISOString() } = {}) {
  return TI_TAB_SECTIONS.flatMap(({ tabContentId, auctionStatus, listingType, idPrefix }) =>
    parseEcariAuctionRows(extractTabSection(html, tabContentId), {
      canton: TI_CANTON,
      plateCode: TI_PLATE_CODE,
      officialAuctionUrl: TI_AUCTION_URL,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix,
      detailUrlBuilder: () => TI_AUCTION_URL,
    }),
  );
}

export async function fetchTiPlateAuctions() {
  const html = await fetchHtml(TI_AUCTION_URL);
  return parseTiAuctionRows(html, { fetchedAt: new Date().toISOString() });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchTiPlateAuctions()
    .then((auctions) => {
      console.log(JSON.stringify(auctions, null, 2));
      console.log(`\n${auctions.length} TI plate auction(s)/listing(s) found across tab1/tab2/tab3/tab4.`);
    })
    .catch((error) => {
      console.error('TI plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
