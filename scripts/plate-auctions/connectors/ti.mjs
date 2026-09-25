#!/usr/bin/env node
/** Ticino eCari connector. The institutional page points to this public portal. */
import {
  buildEcariDetailUrl,
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
  withEcariEmptyState,
} from '../../../functions/src/plateAuctionsCore.js';
import { fetchWithPublicApiRelay } from './api-relay.mjs';
import { requireEcariCataloguePage } from './ecari.mjs';

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
  return withEcariEmptyState(TI_TAB_SECTIONS.flatMap(({ tabContentId, auctionStatus, listingType, idPrefix }) =>
    parseEcariAuctionRows(extractTabSection(html, tabContentId), {
      canton: TI_CANTON,
      plateCode: TI_PLATE_CODE,
      officialAuctionUrl: TI_AUCTION_URL,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix,
      detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl(TI_AUCTION_URL, sourceRecordId),
    }),
  ), html, TI_TAB_SECTIONS.map(({ tabContentId }) => tabContentId));
}

/**
 * Il portale è geo-fenced su IP svizzeri (2026-09-25: da Zurigo e Ginevra
 * serve eCari 432.10.83 «Asta targhe», da ogni sonda non svizzera la pagina
 * F5 «Pagina non disponibile»). Dal runner GitHub la fetch diretta fallisce
 * quindi per costruzione e le righe arrivano dal relay della Cloud Function di
 * Zurigo; `fetchPage` è iniettabile per i test.
 */
export async function fetchTiPlateAuctions({ fetchPage = fetchHtml, now = new Date() } = {}) {
  return fetchWithPublicApiRelay({
    sourceKey: 'ti',
    plateCode: TI_PLATE_CODE,
    officialAuctionUrl: TI_AUCTION_URL,
    now,
    logLabel: 'fetchTiPlateAuctions',
    direct: async () => {
      const html = requireEcariCataloguePage(await fetchPage(TI_AUCTION_URL), {
        plateCode: TI_PLATE_CODE,
        officialAuctionUrl: TI_AUCTION_URL,
      });
      return parseTiAuctionRows(html, { fetchedAt: new Date().toISOString() });
    },
  });
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
