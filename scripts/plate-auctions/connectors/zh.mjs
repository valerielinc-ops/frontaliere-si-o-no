#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/** Zurich official auction-platform connector. */
import {
  explicitlyEmptyCatalogue,
  fetchHtml,
  parseZhAuctionCards,
} from '../../../functions/src/plateAuctionsCore.js';

export const ZH_CANTON = 'Zurigo';
export const ZH_PLATE_CODE = 'ZH';
export const ZH_AUCTION_URL = 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car';

const ZH_AUCTION_LINK_RE = /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/auction\/[^"']*["'][^>]*>/i;

function hasHtmlClass(html, className) {
  return [...String(html || '').matchAll(/\bclass\s*=\s*(["'])([^"']*)\1/gi)]
    .some((match) => match[2].split(/\s+/).includes(className));
}

// Between auction rounds ZH keeps the complete catalogue/search shell and
// answers with this source-specific no-results message (observed 2026-10-15).
// Requiring the shell and rejecting every auction link keeps parser drift red.
export function isZhCatalogueExplicitlyEmpty(html) {
  const source = String(html || '');
  if (!source || !hasHtmlClass(source, 'auction-grid') || !hasHtmlClass(source, 'auctions')) return false;
  if (ZH_AUCTION_LINK_RE.test(source)) return false;
  const text = source
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return /Keine\s+Ergebnisse\s+f(?:ü|&uuml;)r\s+Ihre\s+Suche\.?/i.test(text)
    && /Herzlich\s+willkommen/i.test(text)
    && /Kontrollschild/i.test(text)
    && /Suchen/i.test(text);
}

export function parseZhAuctions(html, { fetchedAt = new Date().toISOString() } = {}) {
  const rows = parseZhAuctionCards(html, {
    fetchedAt,
    officialAuctionUrl: ZH_AUCTION_URL,
    detailBaseUrl: 'https://www.auktion.stva.zh.ch',
  });
  return rows.length === 0 && isZhCatalogueExplicitlyEmpty(html)
    ? explicitlyEmptyCatalogue()
    : rows;
}

export async function fetchZhPlateAuctions() {
  const html = await fetchHtml(ZH_AUCTION_URL);
  return parseZhAuctions(html, { fetchedAt: new Date().toISOString() });
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  fetchZhPlateAuctions()
    .then((auctions) => console.log(JSON.stringify(auctions, null, 2)))
    .catch((error) => {
      console.error('ZH plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
