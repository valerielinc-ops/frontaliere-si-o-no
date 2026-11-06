/**
 * Stable catalogue endpoints used by both plate-auction collectors.
 *
 * GR's public root can serve the canton maintenance shell while the eCari
 * application path still serves the official catalogue. The portal's Swiss
 * locale is case-sensitive in this route: `de_CH` is the catalogue locale,
 * while the lower-case variant can resolve to the maintenance shell. Keep
 * this fetch path shared so the static and Cloud Function collectors cannot
 * drift apart.
 */
export const GR_ECARI_CATALOGUE_URL = 'https://eauktion.gr.ch/ecari-auction/ui/app/init?locale=de_CH';

/**
 * OCN's current public page links to the eCari application root. Keep this
 * endpoint shared by the Cloud Function, static collector and source registry;
 * the portal can redirect from the root to its current application route.
 */
export const FR_ECARI_CATALOGUE_URL = 'https://appls.ocn.ch/ecari-auction?locale=fr_ch';

/**
 * BE publishes the same official catalogue on both host aliases. The edge
 * currently returns 404 for one alias intermittently while the other still
 * serves the catalogue, so both collectors try the registry URL first and
 * the official alias second. A failure on both URLs still degrades the source.
 */
export const BE_AUCTION_URLS = Object.freeze([
  'https://auktion-be.ch/de/',
  'https://www.auktion-be.ch/de/',
]);

/**
 * TG publishes the same official card catalogue on both host aliases. The
 * edge has returned a transient 404 for one alias while the other still
 * served the catalogue (run 39723591585), so both collectors try the
 * canonical registry URL first and the official alias second.
 */
export const TG_AUCTION_URLS = Object.freeze([
  'https://auktion.tg.ch/de/',
  'https://www.auktion.tg.ch/de/',
]);
