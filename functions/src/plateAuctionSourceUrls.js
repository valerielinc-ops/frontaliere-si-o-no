/**
 * Stable catalogue endpoints used by both plate-auction collectors.
 *
 * GR's public root can serve the canton maintenance shell while the eCari
 * application path still serves the official catalogue. Keep that fetch path
 * shared so the static and Cloud Function collectors cannot drift apart.
 */
export const GR_ECARI_CATALOGUE_URL = 'https://eauktion.gr.ch/ecari-auction/ui/app/init?locale=de_ch';
