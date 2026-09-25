#!/usr/bin/env node
/**
 * Configurable eCari connector used by cantons that expose the same public
 * four-tab catalogue. The parser remains in functions/src so the local
 * snapshot and the deployed collector share the exact same implementation.
 */
import {
  buildEcariDetailUrl,
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
  withEcariEmptyState,
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
  const rows = tabs.flatMap(([tabContentId, auctionStatus, listingType, idSuffix]) =>
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
      detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl(officialAuctionUrl, sourceRecordId),
    }),
  );
  // No rows is either the portal's own "no auction running" page or a page
  // we could not read; only the first is a healthy empty catalogue.
  return withEcariEmptyState(rows, html, tabs.map(([tabContentId]) => tabContentId));
}

/**
 * Il geo-fence di TI non fallisce: risponde HTTP 200 con la pagina F5
 * «Pagina non disponibile» (6'967 byte), che il parser legge come zero righe
 * e quindi come `zero_rows`, senza mai arrivare al relay. Una risposta senza
 * nemmeno la scheda d'asta non è un catalogo eCari: per le fonti servite dal
 * relay diventa un errore della fetch diretta.
 */
export function requireEcariCataloguePage(html, { plateCode, officialAuctionUrl }) {
  if (!extractEcariTabSection(html, "tabContent1")) {
    throw new Error(`${plateCode}: ${officialAuctionUrl} did not serve an eCari catalogue (no tabContent1)`);
  }
  return html;
}

export async function fetchEcariCantonAuctions(config) {
  const html = await fetchHtml(config.officialAuctionUrl);
  return parseEcariCantonAuctions(html, {
    ...config,
    fetchedAt: new Date().toISOString(),
  });
}
