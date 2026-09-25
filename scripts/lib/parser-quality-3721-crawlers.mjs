/**
 * Crawler keys targeted by the #3721 flat-prose/duplicate-description data
 * repair: the 4 crawlers from the 2026-05-07 ratchet regression plus the 21
 * flat-prose CRITICAL crawlers + lis-lugano-istituti-sociali (duplicate
 * JS-leak) + 2 siblings (clinique-de-la-plaine, rfsm-fribourg) found via the
 * same htmlToText + destructive-newline-collapse pattern, from 2026-07-08 —
 * plus hilti, kispi, vz-vermoegenszentrum, found in a fresh `--strict` audit
 * re-run the same day: same free-cascade inline-`•`-marker flattening
 * signature, just not caught by the first sweep.
 *
 * Shared between `backfill-bullet-normalization.mjs` (fixes source-language
 * `description`) and `clear-flattened-locale-translations.mjs` (fixes
 * translated `descriptionByLocale` entries) so the two repair passes stay in
 * sync on scope — pulling this from a data module instead of importing one
 * script from the other avoids re-running a script's top-level side effects
 * as an import side-effect.
 */
export const TARGET_KEYS = new Set([
  'eoc-ente-ospedaliero-cantonale',
  'kanton-gr',
  'marriott',
  'vtg',
  'csl-behring',
  'uzh',
  'pdag',
  'viva-luzern',
  'kanton-basel-landschaft',
  'baloise',
  'spital-uster',
  'transgourmet',
  'hoch-health',
  'spital-emmental',
  'ipw',
  'klinik-schoenberg',
  'nsn-medical',
  'schindler',
  'etavis',
  'spruengli',
  'patek-philippe',
  'victorinox',
  'pallas-kliniken',
  'stiftung-diaconis',
  'manor',
  'lis-lugano-istituti-sociali',
  'clinique-de-la-plaine',
  'rfsm-fribourg',
  'hilti',
  'kispi',
  'vz-vermoegenszentrum',
  'eraneos',
  'ferrovia-retica',
  'helsana',
  'postauto',
  // 2026-07-10 (#3836): NEW-OFFENDER set from the no-structure ratchet. Their
  // source-language `description` still has bullets but every byLocale slot was
  // flattened by the (now fixed) mergeLocaleTextMap normalizeSpace defect —
  // invisible to the original byLocale-only structure-evidence scan.
  'idorsia',
  'interdiscount',
  'spitaeler-schaffhausen',
]);
