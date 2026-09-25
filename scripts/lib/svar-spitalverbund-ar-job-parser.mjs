#!/usr/bin/env node
/**
 * Spitalverbund Appenzell Ausserrhoden (SVAR) — Solique career-portal.
 *
 * SVAR runs the Spital Herisau, the Psychiatrische Klinik Herisau and the
 * Psychiatrisches Zentrum AR — the public health network of the canton of
 * Appenzell Ausserrhoden (~1'700 collaborators). Public career landing:
 *   https://www.svar.ch/jobs (corporate)
 *   https://live.solique.ch/svar/ (Solique listing, ~10 active jobs)
 *
 * The SVAR Solique template uses the "link-button" tile variant
 * (`<h3 class="jobtitle">` + `<div class="link"><a id href="job/details/{ID}">`)
 * and the "offer-section" detail body (`<div class="offer">` with
 * `<h4 class="sub-subtitle">` headings) — both handled by the shared
 * `solique-common.mjs` factory.
 */
import { createSoliqueParser } from './solique-common.mjs';

export const SVAR_KEY = 'svar-spitalverbund-ar';
export const SVAR_COMPANY_NAME = 'Spitalverbund Appenzell Ausserrhoden (SVAR)';
export const SVAR_COMPANY_DOMAIN = 'svar.ch';

function svarPostalCodeForCity(city = '') {
  const c = String(city || '').toLowerCase();
  if (c.includes('herisau')) return '9100';
  if (c.includes('teufen')) return '9053';
  if (c.includes('heiden')) return '9410';
  if (c.includes('gais')) return '9056';
  return '9100'; // Herisau default
}

const parser = createSoliqueParser({
  soliqueTenant: 'svar',
  companyKey: SVAR_KEY,
  companyName: SVAR_COMPANY_NAME,
  companyDomain: SVAR_COMPANY_DOMAIN,
  publicCareerUrl: 'https://www.svar.ch/jobs',
  defaultCanton: 'AR',
  defaultCity: 'Herisau',
  defaultPostalCode: '9100',
  defaultSourceLang: 'de',
  sourceLabel: `${SVAR_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
  postalCodeForCity: svarPostalCodeForCity,
});

export const fetchAllSvarJobs = parser.fetchAllJobs;
export const isSvarJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
