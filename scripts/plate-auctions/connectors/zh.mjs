#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Zurich official auction-platform connector. */
import {
  explicitlyEmptyCatalogue,
  fetchHtml,
  isCardCatalogueExplicitlyEmpty,
  parseZhAuctionCards,
} from '../../../functions/src/plateAuctionsCore.js';

export const ZH_CANTON = 'Zurigo';
export const ZH_PLATE_CODE = 'ZH';
export const ZH_AUCTION_URL = 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car';

// Keep the ZH connector on the shared card-platform empty-state contract.
// The newer source response omits the legacy catalogue containers, so the
// exact no-results marker plus search controls and no auction links are the
// evidence of an explicitly empty catalogue.
export function isZhCatalogueExplicitlyEmpty(html) {
  return isCardCatalogueExplicitlyEmpty(html);
}

export function parseZhAuctions(html, { fetchedAt = new Date().toISOString() } = {}) {
  const rows = parseZhAuctionCards(html, {
    fetchedAt,
    officialAuctionUrl: ZH_AUCTION_URL,
    detailBaseUrl: 'https://www.auktion.stva.zh.ch',
  });
  return rows.length === 0 && isZhCatalogueExplicitlyEmpty(html)
    ? explicitlyEmptyCatalogue()
    : rows;
}

export async function fetchZhPlateAuctions() {
  const html = await fetchHtml(ZH_AUCTION_URL);
  return parseZhAuctions(html, { fetchedAt: new Date().toISOString() });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchZhPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error('ZH plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
