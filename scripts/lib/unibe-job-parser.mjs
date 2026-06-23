#!/usr/bin/env node
/**
 * Universität Bern (UniBE) job parser — Prospective.ch (medium 1001892).
 *
 * UniBE is one of Switzerland's largest universities. Its public job portal
 * (https://jobs.unibe.ch/) embeds a Prospective.ch careercenter; the careercenter
 * ID matches the Prospective v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1001892/jobs?lang=de
 *
 * All postings are in canton Bern (academic, research, administrative roles).
 * Canton BE, postal 3012 (Hochschulstrasse 6, Bern).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const UNIBE_KEY = 'unibe';
export const UNIBE_COMPANY_NAME = 'Universität Bern';
export const UNIBE_COMPANY_DOMAIN = 'unibe.ch';

const parser = createProspectiveChParser({
  companyKey: UNIBE_KEY,
  companyName: UNIBE_COMPANY_NAME,
  companyDomain: UNIBE_COMPANY_DOMAIN,
  mediumId: '1001892',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3012',
  publicCareerUrl: 'https://jobs.unibe.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.unibe.ch'],
});

export const fetchAllUnibeJobs = parser.fetchAllJobs;
export const isUnibeJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
