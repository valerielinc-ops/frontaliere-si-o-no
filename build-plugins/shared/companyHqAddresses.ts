/**
 * TypeScript compatibility facade for the Node-loadable address registry.
 *
 * The crawler entrypoints run directly under Node, so the implementation
 * lives in the adjacent `.mjs` module. Build plugins and existing TypeScript
 * imports keep this path as a typed compatibility surface.
 */

export interface CompanyHqAddress {
  streetAddress: string;
  postalCode: string;
  addressLocality: string;
  /** Schema.org-compliant Swiss canton code (ISO 3166-2:CH suffix). */
  addressRegion: string;
}

export {
  COMPANY_HQ_ADDRESSES,
  CITY_FALLBACK_ADDRESSES,
  CANTON_CAPITAL_ADDRESSES,
  DEFAULT_CANTON_REGION,
  deriveCantonFromCity,
  localityMatchesHq,
  regionLocalityCapital,
  resolveFallbackAddress,
} from './companyHqAddresses.mjs';
