#!/usr/bin/env node
/**
 * Étab. Hospitaliers du Nord Vaudois (eHnv) job parser — jobup.ch feed (mask `ehnv`).
 *
 * Public career site: https://www.ehnv.ch/emplois
 * jobup feed:         https://www.jobup.ch/masks/ehnv/list_ehnv.asp?cmd=json
 *
 * 1'800 employees across 5 sites (Yverdon, La Vallée / Le Sentier, Saint-Loup,
 * Orbe, Chamblon). Uses the jobup.ch mask integration; same JSON shape as PSPE.
 *
 * NOTE: at parser creation the feed returned 0 jobs — eHnv may also surface
 * vacancies on `www.ehnv.ch/emplois` directly. Re-evaluate if the jobup feed
 * stays empty long-term.
 */
import { createJobupChFeedParser } from './jobup-ch-feed-common.mjs';

export const EHNV_KEY = 'ehnv';
export const EHNV_COMPANY_NAME = 'Étab. Hospitaliers du Nord Vaudois (eHnv)';
export const EHNV_COMPANY_DOMAIN = 'ehnv.ch';

const parser = createJobupChFeedParser({
  companyKey: EHNV_KEY,
  companyName: EHNV_COMPANY_NAME,
  companyDomain: EHNV_COMPANY_DOMAIN,
  jobupKey: 'ehnv',
  defaultCanton: 'VD',
  defaultCity: 'Yverdon-les-Bains',
  defaultPostalCode: '1400',
  publicCareerUrl: 'https://www.ehnv.ch/emplois',
  defaultSourceLang: 'fr',
});

export const fetchAllEhnvJobs = parser.fetchAllJobs;
export const isEhnvJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
