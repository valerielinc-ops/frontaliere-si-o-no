#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Turgovia official auction-card connector. */
import { fetchCardCantonAuctions, parseCardCantonAuctions } from "./cards.mjs";

export const TG_CANTON = "Turgovia";
export const TG_PLATE_CODE = "TG";
export const TG_AUCTION_URL = "https://www.auktion.tg.ch/de/";

export function parseTgAuctionRows(
  html,
  { fetchedAt = new Date().toISOString() } = {},
) {
  return parseCardCantonAuctions(html, {
    canton: TG_CANTON,
    plateCode: TG_PLATE_CODE,
    officialAuctionUrl: TG_AUCTION_URL,
    detailBaseUrl: "https://www.auktion.tg.ch",
    fetchedAt,
  });
}

export async function fetchTgPlateAuctions() {
  return fetchCardCantonAuctions({
    canton: TG_CANTON,
    plateCode: TG_PLATE_CODE,
    officialAuctionUrl: TG_AUCTION_URL,
    detailBaseUrl: "https://www.auktion.tg.ch",
  });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchTgPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("TG plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
