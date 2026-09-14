#!/usr/bin/env node
/** Sciaffusa official auction-card connector. */
import { fetchCardCantonAuctions, parseCardCantonAuctions } from "./cards.mjs";

export const SH_CANTON = "Sciaffusa";
export const SH_PLATE_CODE = "SH";
export const SH_AUCTION_URL = "https://www.auktion-stva.sh.ch/";

export function parseShAuctionRows(
  html,
  { fetchedAt = new Date().toISOString() } = {},
) {
  return parseCardCantonAuctions(html, {
    canton: SH_CANTON,
    plateCode: SH_PLATE_CODE,
    officialAuctionUrl: SH_AUCTION_URL,
    detailBaseUrl: "https://www.auktion-stva.sh.ch",
    fetchedAt,
  });
}

export async function fetchShPlateAuctions() {
  return fetchCardCantonAuctions({
    canton: SH_CANTON,
    plateCode: SH_PLATE_CODE,
    officialAuctionUrl: SH_AUCTION_URL,
    detailBaseUrl: "https://www.auktion-stva.sh.ch",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchShPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SH plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
