#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** San Gallo public eCari connector. */
import {
  fetchEcariCantonAuctions,
  parseEcariCantonAuctions,
} from "./ecari.mjs";

export const SG_CANTON = "San Gallo";
export const SG_PLATE_CODE = "SG";
export const SG_AUCTION_URL =
  "https://egov.stva.sg.ch/ecari-auction/ui/app/init";

export function parseSgAuctionRows(
  html,
  { fetchedAt = new Date().toISOString() } = {},
) {
  return parseEcariCantonAuctions(html, {
    canton: SG_CANTON,
    plateCode: SG_PLATE_CODE,
    officialAuctionUrl: SG_AUCTION_URL,
    fetchedAt,
  });
}

export async function fetchSgPlateAuctions() {
  return fetchEcariCantonAuctions({
    canton: SG_CANTON,
    plateCode: SG_PLATE_CODE,
    officialAuctionUrl: SG_AUCTION_URL,
  });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchSgPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SG plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
