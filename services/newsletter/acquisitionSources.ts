/**
 * Newsletter acquisition source whitelist — single source of truth shared
 * between client (NewsletterPopup) and Cloud Function (signup endpoint).
 *
 * Pattern per /plan-eng-review D6:
 *   - Hardcoded const tuple, not codegen (preference: explicit > clever).
 *   - Cloud Function imports the same module to validate at runtime.
 *   - Adding a new acquisition source = single-line edit here, type-safe
 *     at build time across both client and server.
 */

export const ACQUISITION_SOURCES = [
  // Weather city pages (PR2)
  'weather-city-lugano',
  'weather-city-bellinzona',
  'weather-city-mendrisio',
  'weather-city-locarno',
  'weather-city-chiasso',
  'weather-city-como',
  'weather-city-varese',
  'weather-city-lecco',

  // Weather alert pages (PR3)
  'weather-alert-snow-gottardo',
  'weather-alert-nebbia-mendrisio',
  'weather-alert-gelo-confine',
  'weather-alert-vento-forte-mendrisio',
  'weather-alert-grandine-lecco',
  'weather-alert-ondata-caldo-ticino',
  'weather-alert-alluvione-rischio',
  'weather-alert-ghiaccio-strade',

  // F8 valico fusion pages (PR3)
  'border-wait-chiasso',
  'border-wait-stabio',
  'border-wait-gandria',
  'border-wait-ponte-tresa',
  'border-wait-gaggiolo',

  // Hub pages
  'weather-hub',
  'weather-alerts-hub',
] as const;

export type AcquisitionSource = typeof ACQUISITION_SOURCES[number];

const ACQUISITION_SET: ReadonlySet<string> = new Set(ACQUISITION_SOURCES);

/**
 * Type guard for runtime validation. Cloud Function calls this on every
 * subscription request. Client uses the typed const directly.
 */
export function isValidAcquisitionSource(value: unknown): value is AcquisitionSource {
  return typeof value === 'string' && ACQUISITION_SET.has(value);
}
