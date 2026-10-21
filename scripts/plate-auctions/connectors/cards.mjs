#!/usr/bin/env node
/** Configurable connector for the card-based official auction platforms. */
import {
  fetchHtml,
  parseZhAuctionCards,
} from "../../../functions/src/plateAuctionsCore.js";
import { fetchWithPublicApiRelay } from './api-relay.mjs';

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

export async function fetchCardCantonAuctions(config, { now = new Date() } = {}) {
  return fetchWithPublicApiRelay({
    sourceKey: String(config.plateCode).toLowerCase(),
    plateCode: config.plateCode,
    officialAuctionUrl: config.officialAuctionUrl,
    now,
    logLabel: `fetch${config.plateCode}PlateAuctions`,
    direct: async () => {
      const html = await fetchHtml(config.officialAuctionUrl);
      return parseCardCantonAuctions(html, {
        ...config,
        fetchedAt: now.toISOString(),
      });
    },
  });
}
