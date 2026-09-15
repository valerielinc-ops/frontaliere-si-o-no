#!/usr/bin/env node
/** Svitto public eCari connector. */
import {
  fetchEcariCantonAuctions,
  parseEcariCantonAuctions,
} from "./ecari.mjs";
import { fetchHtml } from "../../../functions/src/plateAuctionsCore.js";

export const SZ_CANTON = "Svitto";
export const SZ_PLATE_CODE = "SZ";
export const SZ_AUCTION_URL =
  "https://cariegov.sz.ch/ecari-auction/ui/app/init";
export const SZ_PUBLIC_API_RELAY_URL =
  "https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions";
const SZ_API_RELAY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function rowsFromPublicApiRelay(payload, now) {
  const source = payload?.sources?.sz;
  const lastSuccessAt = source?.lastSuccessAt;
  const lastSuccessMs = Date.parse(lastSuccessAt || "");
  if (source?.status !== "active" || !Number.isFinite(lastSuccessMs)) {
    throw new Error("SZ API relay source is not healthy");
  }
  if (now.getTime() - lastSuccessMs > SZ_API_RELAY_MAX_AGE_MS) {
    throw new Error("SZ API relay source is too old");
  }
  const rows = Array.isArray(payload?.auctions)
    ? payload.auctions.filter((row) => String(row?.sourceKey || "").toUpperCase() === SZ_PLATE_CODE)
    : [];
  if (rows.length === 0 || Number(source.rowCount) < 1) {
    throw new Error("SZ API relay returned no current rows");
  }
  return rows.map((row) => ({
    ...row,
    officialAuctionUrl: SZ_AUCTION_URL,
  }));
}

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
  try {
    return await fetcher({
      canton: SZ_CANTON,
      plateCode: SZ_PLATE_CODE,
      officialAuctionUrl: SZ_AUCTION_URL,
    });
  } catch (directError) {
    if (process.env.PLATE_AUCTION_ENABLE_API_RELAY !== "1") throw directError;

    try {
      const response = await fetchHtml(SZ_PUBLIC_API_RELAY_URL);
      const payload = JSON.parse(response);
      const rows = rowsFromPublicApiRelay(payload, now);
      console.warn(`[fetchSzPlateAuctions] official endpoint failed; used API relay: ${errorMessage(directError)}`);
      return rows;
    } catch (relayError) {
      throw new Error(
        `SZ official endpoint failed (${errorMessage(directError)}); API relay failed (${errorMessage(relayError)})`,
        { cause: relayError },
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchSzPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error("SZ plate-auction fetch failed:", error);
      process.exitCode = 1;
    });
}
