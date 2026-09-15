#!/usr/bin/env node
/**
 * Verified public canton catalogues that reuse the eCari/card contracts.
 *
 * Keep the source matrix here deliberately explicit: a source only becomes
 * active after its live markup has been checked against the shared parser.
 */
import {
  SWISSSIGN_RSA_TLS_OV_ICA_2022_1,
  fetchHtml,
} from '../../../functions/src/plateAuctionsCore.js';
import {
  fetchEcariCantonAuctions,
  parseEcariCantonAuctions,
} from './ecari.mjs';
import {
  fetchCardCantonAuctions,
  parseCardCantonAuctions,
} from './cards.mjs';

export const EXPANDED_ECARI_SOURCES = Object.freeze({
  ar: { canton: 'Appenzello Esterno', plateCode: 'AR', officialAuctionUrl: 'https://eauktion.ar.ch/ecari-auction/ui/app/init' },
  bl: { canton: 'Basilea Campagna', plateCode: 'BL', officialAuctionUrl: 'https://eauktion.bl.ch/ecari-auction/ui/app/init' },
  fr: { canton: 'Friburgo', plateCode: 'FR', officialAuctionUrl: 'https://appls.ocn.ch/ecari-auction/ui/app/init?locale=fr_ch' },
  nw: { canton: 'Nidvaldo', plateCode: 'NW', officialAuctionUrl: 'https://ecarinwprod.ilz.info/ecari-auction/' },
  ow: { canton: 'Obvaldo', plateCode: 'OW', officialAuctionUrl: 'https://ecariowprod.ilz.info/ecari-auction/' },
  so: { canton: 'Soletta', plateCode: 'SO', officialAuctionUrl: 'https://eauktion.so.ch/ecari-auction' },
});

export const EXPANDED_CARD_SOURCES = Object.freeze({
  ag: { canton: 'Argovia', plateCode: 'AG', officialAuctionUrl: 'https://www.auktion-ag.ch', detailBaseUrl: 'https://www.auktion-ag.ch' },
  be: { canton: 'Berna', plateCode: 'BE', officialAuctionUrl: 'https://www.auktion-be.ch/de/', detailBaseUrl: 'https://www.auktion-be.ch' },
  vd: { canton: 'Vaud', plateCode: 'VD', officialAuctionUrl: 'https://www.encheres-vd.ch/de/', detailBaseUrl: 'https://www.encheres-vd.ch' },
});

export function parseExpandedEcari(sourceKey, html, { fetchedAt = new Date().toISOString() } = {}) {
  const config = EXPANDED_ECARI_SOURCES[sourceKey];
  if (!config) throw new Error(`Unknown expanded eCari source: ${sourceKey}`);
  return parseEcariCantonAuctions(html, { ...config, fetchedAt });
}

export async function fetchExpandedEcari(sourceKey) {
  const config = EXPANDED_ECARI_SOURCES[sourceKey];
  if (!config) throw new Error(`Unknown expanded eCari source: ${sourceKey}`);
  if (sourceKey === 'fr') {
    const html = await fetchHtml(config.officialAuctionUrl, { ca: SWISSSIGN_RSA_TLS_OV_ICA_2022_1 });
    return parseExpandedEcari(sourceKey, html, { fetchedAt: new Date().toISOString() });
  }
  return fetchEcariCantonAuctions(config);
}

export function parseExpandedCard(sourceKey, html, { fetchedAt = new Date().toISOString() } = {}) {
  const config = EXPANDED_CARD_SOURCES[sourceKey];
  if (!config) throw new Error(`Unknown expanded card source: ${sourceKey}`);
  return parseCardCantonAuctions(html, { ...config, fetchedAt });
}

export async function fetchExpandedCard(sourceKey) {
  const config = EXPANDED_CARD_SOURCES[sourceKey];
  if (!config) throw new Error(`Unknown expanded card source: ${sourceKey}`);
  return fetchCardCantonAuctions(config);
}
