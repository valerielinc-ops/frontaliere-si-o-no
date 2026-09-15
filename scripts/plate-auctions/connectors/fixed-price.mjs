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
  extractPdfUrl,
  fetchHtml,
  fetchJson,
  fetchPdfText,
  parseAiFixedPricePdfText,
  parseBsFixedPricePdfText,
  parseGlFixedPriceJson,
  parseLuFixedPricePdfText,
  parseUrFixedPricePdfText,
} from '../../../functions/src/plateAuctionsCore.js';

const PARSERS = {
  ai: parseAiFixedPricePdfText,
  bs: parseBsFixedPricePdfText,
  lu: parseLuFixedPricePdfText,
  ur: parseUrFixedPricePdfText,
  gl: parseGlFixedPriceJson,
};

export async function fetchFixedPriceSource(sourceKey) {
  const config = FIXED_PRICE_SOURCE_CONFIGS[sourceKey];
  const parse = PARSERS[sourceKey];
  if (!config || typeof parse !== 'function') throw new Error(`Unknown fixed-price source: ${sourceKey}`);
  const fetchedAt = new Date().toISOString();
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
    const pdfUrl = variant.pdfUrlPattern
      ? extractPdfUrl(indexHtml, {
        baseUrl: config.pageUrl,
        pattern: variant.pdfUrlPattern,
      }) || variant.fallbackPdfUrl
      : variant.fallbackPdfUrl;
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
}

export const fetchAiFixedPrice = () => fetchFixedPriceSource('ai');
export const fetchBsFixedPrice = () => fetchFixedPriceSource('bs');
export const fetchGlFixedPrice = () => fetchFixedPriceSource('gl');
export const fetchLuFixedPrice = () => fetchFixedPriceSource('lu');
export const fetchUrFixedPrice = () => fetchFixedPriceSource('ur');
