/**
 * Official fixed-price plate catalogues.
 *
 * These are intentionally separate from auction connectors: the public
 * sources expose reservation/sale inventories, not bids or winners. Rows are
 * therefore emitted as listingType=fixed-price with the published price as a
 * starting price.
 */
import {
  FIXED_PRICE_SOURCE_CONFIGS,
  fetchHtml,
  fetchJson,
  fetchPdfText,
  resolveVariantPdfUrl,
  parseAiFixedPricePdfText,
  parseBsFixedPricePdfText,
  parseGlFixedPriceJson,
  parseLuFixedPricePdfText,
  parseUrFixedPricePdfText,
} from '../../../functions/src/plateAuctionsCore.js';
import { fetchWithPublicApiRelay } from './api-relay.mjs';

const PARSERS = {
  ai: parseAiFixedPricePdfText,
  bs: parseBsFixedPricePdfText,
  gl: parseGlFixedPriceJson,
  lu: parseLuFixedPricePdfText,
  ur: parseUrFixedPricePdfText,
};

export async function fetchFixedPriceSource(sourceKey, { now = new Date() } = {}) {
  const config = FIXED_PRICE_SOURCE_CONFIGS[sourceKey];
  const parse = PARSERS[sourceKey];
  if (!config || typeof parse !== 'function') throw new Error(`Unknown fixed-price source: ${sourceKey}`);
  const fetchedAt = now.toISOString();
  return fetchWithPublicApiRelay({
    sourceKey,
    plateCode: config.plateCode,
    officialAuctionUrl: config.officialUrl,
    now,
    direct: async () => {
      if (config.kind === 'json') {
        const payload = await fetchJson(config.url);
        return parse(payload, {
          canton: config.canton,
          plateCode: config.plateCode,
          officialUrl: config.officialUrl,
          officialDetailUrl: config.url,
          fetchedAt,
        });
      }

      const indexHtml = await fetchHtml(config.pageUrl);
      const variants = config.pdfVariants || [{
        fallbackPdfUrl: config.fallbackPdfUrl,
        pdfUrlPattern: config.pdfUrlPattern,
      }];
      const rows = [];
      for (const variant of variants) {
        const pdfUrl = resolveVariantPdfUrl(variant, {
          sourceKey,
          pageUrl: config.pageUrl,
          indexHtml,
        });
        const pdf = await fetchPdfText(pdfUrl);
        rows.push(...parse(pdf, {
          canton: config.canton,
          plateCode: config.plateCode,
          officialUrl: config.officialUrl,
          officialDetailUrl: pdfUrl,
          fetchedAt,
          ...(variant.vehicleType ? { vehicleType: variant.vehicleType } : {}),
        }));
      }
      return rows;
    },
  });
}

export const fetchAiFixedPrice = (options) => fetchFixedPriceSource('ai', options);
export const fetchBsFixedPrice = (options) => fetchFixedPriceSource('bs', options);
export const fetchGlFixedPrice = (options) => fetchFixedPriceSource('gl', options);
export const fetchLuFixedPrice = (options) => fetchFixedPriceSource('lu', options);
export const fetchUrFixedPrice = (options) => fetchFixedPriceSource('ur', options);
