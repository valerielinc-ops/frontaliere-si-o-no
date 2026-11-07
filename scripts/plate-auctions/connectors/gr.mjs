#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Grigioni eAuction/eCari connector. */
import {
  buildEcariDetailUrl,
  extractEcariTabSection,
  fetchHtml,
  isExplicitlyEmptyCatalogue,
  parseEcariAuctionRows,
  requireEcariCatalogueRows,
  withEcariEmptyState,
} from '../../../functions/src/plateAuctionsCore.js';
import { GR_ECARI_CATALOGUE_URL } from '../../../functions/src/plateAuctionSourceUrls.js';
import { fetchWithPublicApiRelay, PLATE_AUCTION_PUBLIC_API_RELAY_URL } from './api-relay.mjs';

export const GR_CANTON = 'Grigioni';
export const GR_PLATE_CODE = 'GR';
export const GR_PUBLIC_API_RELAY_URL = PLATE_AUCTION_PUBLIC_API_RELAY_URL;

export function parseGrAuctionRows(html, { fetchedAt = new Date().toISOString() } = {}) {
  const tabs = [
    ['tabContent1', 'active', 'auction', 'gr'],
    ['tabContent2', 'upcoming', 'future-registration', 'gr-future'],
    ['tabContent3', 'active', 'fixed-price', 'gr-fixed'],
    ['tabContent4', 'upcoming', 'wanted', 'gr-wanted'],
  ];
  return withEcariEmptyState(tabs.flatMap(([tab, auctionStatus, listingType, idPrefix]) => parseEcariAuctionRows(
    extractEcariTabSection(html, tab),
    {
      canton: GR_CANTON,
      plateCode: GR_PLATE_CODE,
      officialAuctionUrl: GR_ECARI_CATALOGUE_URL,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix,
      detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl(GR_ECARI_CATALOGUE_URL, sourceRecordId),
    },
  )), html, tabs.map(([tab]) => tab));
}

export async function fetchGrPlateAuctions({ fetchPage = fetchHtml, now = new Date() } = {}) {
  return fetchWithPublicApiRelay({
    sourceKey: 'gr',
    plateCode: GR_PLATE_CODE,
    officialAuctionUrl: GR_ECARI_CATALOGUE_URL,
    now,
    logLabel: 'fetchGrPlateAuctions',
    direct: async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const html = await fetchPage(GR_ECARI_CATALOGUE_URL);
        const rows = parseGrAuctionRows(html, { fetchedAt: new Date().toISOString() });
        if (rows.length > 0 || isExplicitlyEmptyCatalogue(rows)) return rows;
        if (attempt === 1) {
          return requireEcariCatalogueRows(rows, {
            plateCode: GR_PLATE_CODE,
            officialAuctionUrl: GR_ECARI_CATALOGUE_URL,
          });
        }
      }
      throw new Error('GR eCari fetch exhausted without a result');
    },
  });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchGrPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error('GR plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
