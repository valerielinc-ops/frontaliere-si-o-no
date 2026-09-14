#!/usr/bin/env node
/** Svitto public eCari connector. */
import {
  fetchEcariCantonAuctions,
  parseEcariCantonAuctions,
} from "./ecari.mjs";

export const SZ_CANTON = "Svitto";
export const SZ_PLATE_CODE = "SZ";
export const SZ_AUCTION_URL =
  "https://cariegov.sz.ch/ecari-auction/ui/app/init?locale=de_ch";

export function parseSzAuctionRows(
  html,
  { fetchedAt = new Date().toISOString() } = {},
) {
  return parseEcariCantonAuctions(html, {
    canton: SZ_CANTON,
    plateCode: SZ_PLATE_CODE,
    officialAuctionUrl: SZ_AUCTION_URL,
    fetchedAt,
  });
}

export async function fetchSzPlateAuctions() {
  return fetchEcariCantonAuctions({
    canton: SZ_CANTON,
    plateCode: SZ_PLATE_CODE,
    officialAuctionUrl: SZ_AUCTION_URL,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchSzPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SZ plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
