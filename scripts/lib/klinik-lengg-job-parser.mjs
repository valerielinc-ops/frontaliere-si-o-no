#!/usr/bin/env node
/**
 * Klinik Lengg job parser — Prospective.ch (medium 1008440).
 *
 * Public career site: https://kliniklengg.ch/stellenangebote
 *   → embeds iframe to https://jobs.kliniklengg.ch/?lang=de which proxies the
 *     Prospective.ch careercenter 1008440. The same medium ID also serves the
 *     well-known v1 JSON listing endpoint:
 *       https://ohws.prospective.ch/public/v1/medium/1008440/jobs
 *
 * Klinik Lengg AG (8008 Zürich, Bleulerstrasse 60) is a specialist clinic for
 * epileptology and neurological rehabilitation — currently ~22 open positions
 * across nursing, medicine, allied therapies and administration.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const KLINIK_LENGG_KEY = 'klinik-lengg';
export const KLINIK_LENGG_COMPANY_NAME = 'Klinik Lengg';
export const KLINIK_LENGG_COMPANY_DOMAIN = 'kliniklengg.ch';

const parser = createProspectiveChParser({
  companyKey: KLINIK_LENGG_KEY,
  companyName: KLINIK_LENGG_COMPANY_NAME,
  companyDomain: KLINIK_LENGG_COMPANY_DOMAIN,
  mediumId: '1008440',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8008',
  publicCareerUrl: 'https://kliniklengg.ch/stellenangebote',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.kliniklengg.ch', 'klinik-lengg.ch', 'www.kliniklengg.ch'],
});

export const fetchAllKlinikLenggJobs = parser.fetchAllJobs;
export const isKlinikLenggJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
