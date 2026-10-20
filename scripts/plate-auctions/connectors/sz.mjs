#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Svitto public eCari connector. */
import {
  fetchEcariCantonAuctions,
  parseEcariCantonAuctions,
} from "./ecari.mjs";
import {
  fetchWithPublicApiRelay,
  PLATE_AUCTION_PUBLIC_API_RELAY_URL,
} from "./api-relay.mjs";

export const SZ_CANTON = "Svitto";
export const SZ_PLATE_CODE = "SZ";
export const SZ_AUCTION_URL =
  "https://cariegov.sz.ch/ecari-auction/ui/app/init";
export const SZ_PUBLIC_API_RELAY_URL = PLATE_AUCTION_PUBLIC_API_RELAY_URL;

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

export async function fetchSzPlateAuctions({ fetcher = fetchEcariCantonAuctions, now = new Date() } = {}) {
  return fetchWithPublicApiRelay({
    sourceKey: "sz",
    plateCode: SZ_PLATE_CODE,
    officialAuctionUrl: SZ_AUCTION_URL,
    now,
    logLabel: "fetchSzPlateAuctions",
    direct: () => fetcher({
      canton: SZ_CANTON,
      plateCode: SZ_PLATE_CODE,
      officialAuctionUrl: SZ_AUCTION_URL,
    }),
  });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchSzPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SZ plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
