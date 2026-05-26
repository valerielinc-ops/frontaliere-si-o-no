#!/usr/bin/env node
/**
 * Spital Oberengadin job parser — Solique career-portal.
 *
 * Spital Oberengadin (Samedan, GR) is operated by Stiftung Gesundheits-
 * versorgung Oberengadin (SGO). Public career site:
 *   https://www.spital-oberengadin.ch/spital-oberengadin/jobs-und-karriere/offene-stellen
 *   (iframe-embeds Solique at
 *    https://live.solique.ch/stiftung-gesundheitsversorgung-oberengadin/)
 *
 * Solique server-renders the entire listing in a single HTML response.
 * Detail pages live at /job/details/{ID}. The shared factory in
 * `solique-common.mjs` handles tile parsing and detail extraction.
 */
import { createSoliqueParser } from './solique-common.mjs';

export const SPITAL_OBERENGADIN_KEY = 'spital-oberengadin';
export const SPITAL_OBERENGADIN_COMPANY_NAME = 'Spital Oberengadin';
export const SPITAL_OBERENGADIN_COMPANY_DOMAIN = 'spital-oberengadin.ch';

const parser = createSoliqueParser({
  soliqueTenant: 'stiftung-gesundheitsversorgung-oberengadin',
  companyKey: SPITAL_OBERENGADIN_KEY,
  companyName: SPITAL_OBERENGADIN_COMPANY_NAME,
  companyDomain: SPITAL_OBERENGADIN_COMPANY_DOMAIN,
  publicCareerUrl:
    'https://www.spital-oberengadin.ch/spital-oberengadin/jobs-und-karriere/offene-stellen',
  defaultCanton: 'GR',
  defaultCity: 'Samedan',
  defaultPostalCode: '7503',
  defaultSourceLang: 'de',
  sourceLabel: `${SPITAL_OBERENGADIN_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
});

export const fetchAllSpitalOberengadinJobs = parser.fetchAllJobs;
export const isSpitalOberengadinJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
