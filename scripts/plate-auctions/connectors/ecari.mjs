#!/usr/bin/env node
/**
 * Configurable eCari connector used by cantons that expose the same public
 * four-tab catalogue. The parser remains in functions/src so the local
 * snapshot and the deployed collector share the exact same implementation.
 */
import {
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
} from "../../../functions/src/plateAuctionsCore.js";

export const DEFAULT_ECARI_TABS = [
  ["tabContent1", "active", "auction", "auction"],
  ["tabContent2", "upcoming", "future-registration", "future"],
  ["tabContent3", "active", "fixed-price", "fixed"],
  ["tabContent4", "upcoming", "wanted", "wanted"],
];

export function parseEcariCantonAuctions(
  html,
  {
    canton,
    plateCode,
    officialAuctionUrl,
    fetchedAt = new Date().toISOString(),
    tabs = DEFAULT_ECARI_TABS,
  },
) {
  return tabs.flatMap(([tabContentId, auctionStatus, listingType, idSuffix]) =>
    parseEcariAuctionRows(extractEcariTabSection(html, tabContentId), {
      canton,
      plateCode,
      officialAuctionUrl,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix:
        idSuffix === "auction"
          ? plateCode.toLowerCase()
          : `${plateCode.toLowerCase()}-${idSuffix}`,
      detailUrlBuilder: () => officialAuctionUrl,
    }),
  );
}

export async function fetchEcariCantonAuctions(config) {
  const html = await fetchHtml(config.officialAuctionUrl);
  return parseEcariCantonAuctions(html, {
    ...config,
    fetchedAt: new Date().toISOString(),
  });
}
