#!/usr/bin/env node
/**
 * Kantonale Verwaltung Zürich (Kanton Zürich cantonal administration) job parser
 * — Solique career-portal, AngularJS/API board variant.
 *
 * Live source:   https://live.solique.ch/ktzh/de/   (Solique microsite, JSON-driven)
 *   - job list:   https://live.solique.ch/ktzh/de/api/v1/data/   (JSON, ~140 openings)
 *   - job detail: https://live.solique.ch/ktzh/job/details/{id}/  (SSR HTML)
 * Public career: https://www.zh.ch/de/arbeiten-beim-kanton.html (links to the Solique board)
 *
 * Crawled via the shared `createSoliqueParser` in `mode: 'api'`, same board
 * family as `ipw` (JSON list endpoint + SSR detail pages). One shape
 * difference from ipw: the JSON `link` field here is SITE-ABSOLUTE
 * (`/ktzh/job/details/{id}/`) rather than tenant/lang-RELATIVE
 * (`jobs/{slug}--{id}`) — handled generically in `parseSoliqueApiListing`
 * (see `solique-common.mjs`), not special-cased here.
 *
 * Non-healthcare tenant: the cantonal administration spans legal, IT,
 * education, social work, forestry, security and administrative roles —
 * NOT healthcare, so `sector` and `categoryFn` are overridden (the shared
 * factory defaults both to "Sanità / Ospedali" for its healthcare-operator
 * tenants).
 */
import { createSoliqueParser } from './solique-common.mjs';

export const KANTON_ZUERICH_KEY = 'kanton-zuerich';
export const KANTON_ZUERICH_COMPANY_NAME = 'Kantonale Verwaltung Zürich';
export const KANTON_ZUERICH_COMPANY_DOMAIN = 'zh.ch';

/** Postal codes for the municipalities most frequently seen on the board. */
const ZH_POSTAL_CODES = {
  'zürich altstetten': '8048',
  zürich: '8001',
  zurich: '8001',
  winterthur: '8400',
  regensdorf: '8105',
  bülach: '8180',
  uitikon: '8142',
  'affoltern am albis': '8910',
  wetzikon: '8620',
  dietikon: '8953',
  lindau: '8315',
  'pfäffikon zh': '8330',
  pfäffikon: '8330',
  uster: '8610',
  dietlikon: '8305',
  dielsdorf: '8157',
  wallisellen: '8304',
  kloten: '8302',
  dübendorf: '8600',
  küsnacht: '8700',
  glattbrugg: '8152',
  meilen: '8706',
  hinwil: '8340',
  horgen: '8810',
  oberrieden: '8942',
};

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function zhPostalCodeForCity(city = '') {
  const c = normalize(city);
  // Explicit PLZ already embedded in the location string (e.g. "8400 Winterthur").
  const plzMatch = c.match(/\b(8\d{3})\b/);
  if (plzMatch) return plzMatch[1];
  for (const [name, code] of Object.entries(ZH_POSTAL_CODES)) {
    if (c.includes(name)) return code;
  }
  return '8001'; // Zürich (cantonal capital) default
}

/**
 * Public-administration category classifier for the cantonal board. Mirrors
 * `detectHealthcareCategory`'s shape (own regex ladder, most-specific first)
 * but tuned for the Kanton Zürich role mix (legal, security, education,
 * social work, IT, forestry/environment, technical, administration) instead
 * of healthcare — the shared factory's default classifier would otherwise
 * bucket every unmatched title into "Sanità / Ospedali".
 */
function detectPublicAdminCategory(text = '') {
  const t = normalize(text);
  if (/jurist|recht|justiz|straf|gericht|notari|anwalt|advoc|legal/.test(t)) return 'Legale';
  if (/polizei|sicherheit|rettung|justizvollzug|feuerwehr|gefängnis/.test(t)) return 'Sicurezza Pubblica';
  if (/pfleg|medizin|arzt|ärztin|therap|sozial(?!versicherung)|betreuung|jugend.*familie/.test(t)) return 'Sanità e Sociale';
  if (/lehr|pädagog|schule|bildung|dozent|hochschule/.test(t)) return 'Istruzione';
  if (/it\b|informatik|software|develop|applikation|system.*administrat/.test(t)) return 'IT';
  if (/wald|forst|natur|umwelt|landwirtschaft|energie/.test(t)) return 'Ambiente';
  if (/techni|haustechni|facility|bau\b|verkehr/.test(t)) return 'Tecnica';
  if (/admin|sekret|sachbearbeit|kauffrau|kaufmann|buchhalt|finanz|controll/.test(t)) return 'Amministrazione Pubblica';
  if (/hr\b|human resources|personal(?!versicherung)|talent/.test(t)) return 'Risorse Umane';
  return 'Amministrazione Pubblica';
}

const parser = createSoliqueParser({
  soliqueTenant: 'ktzh',
  mode: 'api',
  migratedBoard: true,
  apiLang: 'de',
  companyKey: KANTON_ZUERICH_KEY,
  companyName: KANTON_ZUERICH_COMPANY_NAME,
  companyDomain: KANTON_ZUERICH_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8001',
  publicCareerUrl: 'https://www.zh.ch/de/arbeiten-beim-kanton.html',
  defaultSourceLang: 'de',
  sourceLabel: `${KANTON_ZUERICH_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
  postalCodeForCity: zhPostalCodeForCity,
  sector: 'Amministrazione Pubblica',
  categoryFn: detectPublicAdminCategory,
});

export const fetchAllKantonZuerichJobs = parser.fetchAllJobs;
export const isKantonZuerichJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
