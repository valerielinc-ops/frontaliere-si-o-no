#!/usr/bin/env node
/**
 * Centre Neuchâtelois de Psychiatrie (CNP) job parser — jobup.ch feed (mask `cnp`).
 *
 * Public career site: https://www.cnp.ch/carrieres/
 *   → embeds individual job-detail links to https://www.jobup.ch/fr/emplois/detail/{uuid}/
 *
 * jobup feed: https://www.jobup.ch/masks/cnp/list_cnp.asp?cmd=json
 *
 * CNP is the public psychiatric services network of canton Neuchâtel (NE),
 * covering ambulatory, day-care and inpatient psychiatry across multiple
 * sites (Marin, Préfargier, La Chrysalide). ~22 open positions at parser
 * creation. French-language tenant.
 *
 * Uses the shared jobup.ch feed factory.
 */
import { createJobupChFeedParser } from './jobup-ch-feed-common.mjs';

export const CNP_KEY = 'cnp';
export const CNP_COMPANY_NAME = 'Centre Neuchâtelois de Psychiatrie (CNP)';
export const CNP_COMPANY_DOMAIN = 'cnp.ch';

const parser = createJobupChFeedParser({
  companyKey: CNP_KEY,
  companyName: CNP_COMPANY_NAME,
  companyDomain: CNP_COMPANY_DOMAIN,
  jobupKey: 'cnp',
  defaultCanton: 'NE',
  defaultCity: 'Marin-Epagnier',
  defaultPostalCode: '2074',
  publicCareerUrl: 'https://www.cnp.ch/carrieres/',
  defaultSourceLang: 'fr',
});

export const fetchAllCnpJobs = parser.fetchAllJobs;
export const isCnpJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
