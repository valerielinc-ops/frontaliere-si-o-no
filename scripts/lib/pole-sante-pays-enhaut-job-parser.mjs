#!/usr/bin/env node
/**
 * Pôle Santé Pays-d'Enhaut (PSPE) job parser — jobup.ch feed (mask `hpe`).
 *
 * Public career site: https://www.pspe.ch/jcms/lav_5063/fr/offres-d-emploi
 * jobup feed:         https://www.jobup.ch/masks/hpe/list_hpe.asp?cmd=json
 *
 * Regional hospital / EMS in Château-d'Oex (VD), serving the upper Sarine
 * valley. Embeds the Jalios JCMS PluginJobUp which queries the jobup.ch
 * masks endpoint for live vacancies.
 */
import { createJobupChFeedParser } from './jobup-ch-feed-common.mjs';

export const POLE_SANTE_PAYS_ENHAUT_KEY = 'pole-sante-pays-enhaut';
export const POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME = 'Pôle Santé Pays-d\'Enhaut';
export const POLE_SANTE_PAYS_ENHAUT_COMPANY_DOMAIN = 'pspe.ch';

const parser = createJobupChFeedParser({
  companyKey: POLE_SANTE_PAYS_ENHAUT_KEY,
  companyName: POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME,
  companyDomain: POLE_SANTE_PAYS_ENHAUT_COMPANY_DOMAIN,
  jobupKey: 'hpe',
  defaultCanton: 'VD',
  defaultCity: 'Château-d\'Oex',
  defaultPostalCode: '1660',
  publicCareerUrl: 'https://www.pspe.ch/jcms/lav_5063/fr/offres-d-emploi',
  defaultSourceLang: 'fr',
});

export const fetchAllPoleSantePaysEnhautJobs = parser.fetchAllJobs;
export const isPoleSantePaysEnhautJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
