#!/usr/bin/env node
/**
 * St. Claraspital Basel job parser — Prospective.ch (medium 1006906).
 *
 * Public career site: https://www.claraspital.ch/de/jobs-und-karriere
 *   → embeds iframe to https://jobs.claraspital.ch/ (Prospective careercenter 1006906)
 *
 * The careercenter ID matches the Prospective v1 listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1006906/jobs?lang=de
 *
 * St. Claraspital AG (4002 Basel) is a private acute hospital focused on
 * gastroenterology, oncology and abdominal surgery — ~26 open positions in
 * medicine, nursing, allied therapies and administration. Canton BS.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const CLARASPITAL_KEY = 'claraspital';
export const CLARASPITAL_COMPANY_NAME = 'St. Claraspital';
export const CLARASPITAL_COMPANY_DOMAIN = 'claraspital.ch';

const parser = createProspectiveChParser({
  companyKey: CLARASPITAL_KEY,
  companyName: CLARASPITAL_COMPANY_NAME,
  companyDomain: CLARASPITAL_COMPANY_DOMAIN,
  mediumId: '1006906',
  apiLang: 'de',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4002',
  publicCareerUrl: 'https://www.claraspital.ch/de/jobs-und-karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.claraspital.ch'],
});

export const fetchAllClaraspitalJobs = parser.fetchAllJobs;
export const isClaraspitalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
