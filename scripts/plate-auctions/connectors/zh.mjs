#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Zurich official auction-platform connector. */
import {
  fetchHtml,
  parseZhAuctionCards,
} from '../../../functions/src/plateAuctionsCore.js';

export const ZH_CANTON = 'Zurigo';
export const ZH_PLATE_CODE = 'ZH';
export const ZH_AUCTION_URL = 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car';

export function parseZhAuctions(html, { fetchedAt = new Date().toISOString() } = {}) {
  return parseZhAuctionCards(html, {
    fetchedAt,
    officialAuctionUrl: ZH_AUCTION_URL,
    detailBaseUrl: 'https://www.auktion.stva.zh.ch',
  });
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
