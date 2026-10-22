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

export async function fetchCardCantonAuctions(config, { now = new Date(), fetchPage = fetchHtml } = {}) {
  return fetchWithPublicApiRelay({
    sourceKey: String(config.plateCode).toLowerCase(),
    plateCode: config.plateCode,
    officialAuctionUrl: config.officialAuctionUrl,
    now,
    logLabel: `fetch${config.plateCode}PlateAuctions`,
    direct: async () => {
      const fetchUrls = [...new Set([
        config.officialAuctionUrl,
        ...(Array.isArray(config.officialAuctionUrls) ? config.officialAuctionUrls : []),
      ])];
      const errors = [];
      for (const fetchUrl of fetchUrls) {
        try {
          const html = await fetchPage(fetchUrl, {
            ...(config.userAgent ? { userAgent: config.userAgent } : {}),
          });
          return parseCardCantonAuctions(html, {
            ...config,
            // Keep both the public source identity and detail links on the
            // canonical registry host when a transport alias wins.
            detailBaseUrl: config.detailBaseUrl,
            fetchedAt: now.toISOString(),
          });
        } catch (error) {
          errors.push({ fetchUrl, error });
        }
      }
      if (errors.length === 1) throw errors[0].error;
      throw new Error(
        `${config.plateCode} card endpoints failed: ${errors.map(({ fetchUrl, error }) => `${fetchUrl} (${error instanceof Error ? error.message : String(error)})`).join('; ')}`,
        { cause: errors.at(-1)?.error },
      );
    },
  });
}
