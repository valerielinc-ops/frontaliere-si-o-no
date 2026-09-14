#!/usr/bin/env node
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

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchSgPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SG plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
