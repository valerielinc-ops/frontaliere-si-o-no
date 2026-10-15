#!/usr/bin/env node
/** Configurable connector for the card-based official auction platforms. */
import {
  fetchHtml,
  parseZhAuctionCards,
} from "../../../functions/src/plateAuctionsCore.js";

export function parseCardCantonAuctions(
  html,
  {
    canton,
    plateCode,
    officialAuctionUrl,
    detailBaseUrl,
    fetchedAt = new Date().toISOString(),
  },
) {
  return parseZhAuctionCards(html, {
    fetchedAt,
    officialAuctionUrl,
    detailBaseUrl,
    sourceKey: plateCode,
    canton,
    platePrefix: plateCode,
  });
}

export async function fetchCardCantonAuctions(config) {
  const html = await fetchHtml(config.officialAuctionUrl);
  return parseCardCantonAuctions(html, {
    ...config,
    fetchedAt: new Date().toISOString(),
  });
}
