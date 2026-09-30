#!/usr/bin/env node
/**
 * Inselspital Bern — Prospective.ch API (medium 1000666).
 *
 * The public jobs.inselgruppe.ch app is a JavaScript shell. Its public bundle
 * exposes the Prospective endpoint below, whose records contain the complete
 * source sections. The established Umantis vacancy URL remains published so
 * existing vacancy identities and redirects stay stable; its numeric ID is
 * supplied by sza_apply_link in the API record.
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1000666/jobs
 *      ?lang=de&offset=0&limit=100
 */
import { createHash } from 'node:crypto';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const INSELSPITAL_KEY = 'inselspital';
export const INSELSPITAL_COMPANY_NAME = 'Inselspital Bern';
export const INSELSPITAL_COMPANY_DOMAIN = 'insel.ch';

const UMANTIS_TENANT = '2624';
const UMANTIS_BASE = 'https://recruitingapp-' + UMANTIS_TENANT + '.umantis.com';

function hasPublishableSourceBody(listing = {}) {
  const szas = listing?.szas || {};
  return meetsSourceBodyFloor([
    szas.sza_introduction,
    szas.sza_tasks,
    szas.sza_requirements,
    szas.sza_benefits,
    szas.sza_company_profil,
  ].filter(Boolean).join('\n'));
}

function umantisVacancyId(listing = {}) {
  const raw = String(listing?.szas?.sza_apply_link ?? '').trim();
  return /^\d+$/.test(raw) ? raw : '';
}

function umantisDescriptionUrl(listing, { directLink = '' } = {}) {
  const vacancyId = umantisVacancyId(listing);
  return vacancyId
    ? UMANTIS_BASE + '/Vacancies/' + vacancyId + '/Description/1'
    : directLink;
}

function umantisApplyUrl(listing, { directLink = '' } = {}) {
  const vacancyId = umantisVacancyId(listing);
  return vacancyId
    ? UMANTIS_BASE + '/Vacancies/' + vacancyId + '/Application/CheckLogin/1'
    : directLink;
}

const parser = createProspectiveChParser({
  companyKey: INSELSPITAL_KEY,
  companyName: INSELSPITAL_COMPANY_NAME,
  companyDomain: INSELSPITAL_COMPANY_DOMAIN,
  mediumId: '1000666',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3010',
  defaultStreetAddress: 'Freiburgstrasse',
  publicCareerUrl: 'https://jobs.inselgruppe.ch/?lang=de&filter_50=0',
  defaultSourceLang: 'de',
  strictPagination: true,
  siteCantons: {
    Aarberg: 'BE',
    Belp: 'BE',
    Bern: 'BE',
    Heiligenschwendi: 'BE',
    Riggisberg: 'BE',
  },
  extraTrustedHosts: [
    'jobs.inselgruppe.ch',
    'www.inselgruppe.ch',
    'inselgruppe.prospective.ch',
    'ohws.prospective.ch',
    'recruitingapp-2624.umantis.com',
  ],
  filterListing: hasPublishableSourceBody,
  sourceUrlFn: umantisDescriptionUrl,
  applyUrlFn: umantisApplyUrl,
});

export async function fetchAllInselspitalJobs() {
  const jobs = await parser.fetchAllJobs();
  return jobs.map((job) => {
    const match = String(job?.url || '').match(/\/Vacancies\/(\d+)\/Description\//i);
    if (!match) return job;
    const hash = createHash('sha1')
      .update('inselspital-vacancy-' + match[1])
      .digest('hex')
      .slice(0, 12);
    return { ...job, id: 'inselspital-' + hash };
  });
}

export function isInselspitalJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return parser.isCompanyJob(job)
    || url.includes('recruitingapp-' + UMANTIS_TENANT + '.umantis.com');
}

export const isTrustedDomain = parser.isTrustedDomain;
