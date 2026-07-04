#!/usr/bin/env node
/**
 * OTTO'S AG job parser — Solique board (SSR variant, paginated).
 *
 * Live source:   https://live.solique.ch/ottosag/  (Solique SSR careers board)
 *   - job list:   https://live.solique.ch/ottosag/[?page=N]  (HTML, 25/page — ~167 openings, Jul 2026)
 *   - job detail: https://live.solique.ch/ottosag/job/details/{ID}/
 * Public career: https://www.ottos.ch/de/jobs (embeds/links to the Solique board)
 *
 * OTTO'S AG is a Swiss discount retail chain (household goods, food, sports,
 * furniture) with branches across all linguistic regions of Switzerland.
 * Crawled via the shared `createSoliqueParser` factory in `mode: 'ssr'` with
 * `paginate: true` (large tenant, listing spans multiple `?page=N` requests —
 * see `scripts/lib/solique-common.mjs` template (c) / "tasks-profile-wrapper"
 * detail template for the tenant-specific markup quirks this tenant needed
 * the factory extended for) and a retail `sector`/`categoryFn` override
 * (the factory's healthcare defaults do not apply to a retail chain).
 */
import { createSoliqueParser } from './solique-common.mjs';

export const OTTOS_KEY = 'ottos';
export const OTTOS_COMPANY_NAME = "OTTO'S AG";
export const OTTOS_COMPANY_DOMAIN = 'ottos.ch';

/**
 * Retail category classifier for OTTO'S AG roles (sales floor, cashier,
 * warehouse/logistics, management, apprenticeship, back-office). Mirrors the
 * shape of `detectHealthcareCategory` (`scripts/lib/hospital-custom-html-helpers.mjs`)
 * but with retail-appropriate Italian sector labels and a "Vendita" catch-all
 * default instead of that function's "Sanità / Ospedali" default.
 * @param {string} text
 * @returns {string}
 */
function ottosCategoryFn(text = '') {
  const t = String(text || '').toLowerCase();
  if (/lehrling|lernend|apprenti|stage|stagiair|tirocin|praktik|ausbildung|formazione/.test(t)) return 'Formazione';
  if (/filialleit|geschäftsführ|store\s*manager|abteilungsleit|teamleit|direzione|responsabile.{0,15}filiale|responsable.{0,15}magasin|leiter\b|leitung\b/.test(t)) return 'Management';
  if (/logist|lager|magazz|einkauf|transport|approvvig|distribution|distribuz|warendisposition/.test(t)) return 'Logistica';
  if (/\bhr\b|human resources|personal(?:abteilung|dienst|wesen)?|recruit|risorse umane|ressources humaines/.test(t)) return 'Risorse Umane';
  if (/\bit\b|informatik|software|develop|programm|system|applikation/.test(t)) return 'IT';
  if (/market|kommunikation|communicat|comunicaz/.test(t)) return 'Marketing';
  if (/admin|sekret|segret|buchhalt|sachbearbeit|finanz|controll|account|compta|amministra/.test(t)) return 'Amministrazione';
  return 'Vendita';
}

const parser = createSoliqueParser({
  soliqueTenant: 'ottosag',
  mode: 'ssr',
  paginate: true,
  companyKey: OTTOS_KEY,
  companyName: OTTOS_COMPANY_NAME,
  companyDomain: OTTOS_COMPANY_DOMAIN,
  publicCareerUrl: 'https://www.ottos.ch/de/jobs',
  defaultCanton: 'LU',
  defaultCity: 'Sursee',
  defaultPostalCode: '6210', // OTTO'S AG headquarters (Sursee, LU)
  defaultSourceLang: 'de',
  sourceLabel: `${OTTOS_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
  sector: 'Commercio al Dettaglio',
  categoryFn: ottosCategoryFn,
});

export const fetchAllOttosJobs = parser.fetchAllJobs;
export const isOttosJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
