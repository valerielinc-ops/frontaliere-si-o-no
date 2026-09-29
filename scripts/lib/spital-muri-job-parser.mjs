#!/usr/bin/env node
/**
 * Spital Muri AG job parser — Solique careers portal.
 *
 * Public career site: https://www.spital-muri.ch/jobs/stellenangebote.html/725
 *   The page embeds the job board as an iframe on
 *   https://live.solique.ch/spital-muri/ — that board IS the source: ~30
 *   vacancies, each with an SSR detail page at `job/details/{ID}`.
 *
 * Until 2026-09 this crawler read the Umantis tenant 2997
 * (recruitingapp-2997.umantis.com/Jobs/All) that sits behind the board's
 * application links. That listing carries one posting only, «Teststelle RAV
 * Schnittstelle», an interface test left online since 2021 whose body is
 * «titel 1 text 1 … titel 4 text 4» — so the site published a fake vacancy
 * and none of the real ones (issue 5253).
 *
 * Regional acute hospital in Muri, canton Aargau.
 */
import { createSoliqueParser } from './solique-common.mjs';

export const SPITAL_MURI_KEY = 'spital-muri';
export const SPITAL_MURI_COMPANY_NAME = 'Spital Muri';
export const SPITAL_MURI_COMPANY_DOMAIN = 'spital-muri.ch';

const parser = createSoliqueParser({
  soliqueTenant: 'spital-muri',
  companyKey: SPITAL_MURI_KEY,
  companyName: SPITAL_MURI_COMPANY_NAME,
  companyDomain: SPITAL_MURI_COMPANY_DOMAIN,
  publicCareerUrl: 'https://www.spital-muri.ch/jobs/stellenangebote.html/725',
  defaultCanton: 'AG',
  defaultCity: 'Muri',
  defaultPostalCode: '5630',
  defaultSourceLang: 'de',
  sourceLabel: `${SPITAL_MURI_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
  // The board's application and spontaneous-application links stay on the
  // hospital's Umantis tenant.
  extraTrustedHosts: ['recruitingapp-2997.umantis.com'],
  // Detail pages use the introduction/tasks/profile/offer/benefits blocks.
  tasksProfileBoard: true,
});

export const fetchAllSpitalMuriJobs = parser.fetchAllJobs;
export const isSpitalMuriJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
