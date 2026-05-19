#!/usr/bin/env node
/**
 * Viva Luzern job parser — Prospective.ch (medium tenant 1002590).
 *
 * Public career site: https://www.viva-luzern.ch/karriere
 *   The site links each advert to https://ohws.prospective.ch/public/v1/jobs/{viewkey}.
 *   The JSON listing is available at
 *   https://ohws.prospective.ch/public/v1/medium/1002590/jobs?lang=de
 *
 * Viva Luzern is the city-of-Luzern operator for Alterszentren and care homes
 * (Dreilinden, Eichhof, Staffelnhof, Wesemlin etc.). Major employer for nurses
 * and care professionals in canton LU.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const VIVA_LUZERN_KEY = 'viva-luzern';
export const VIVA_LUZERN_COMPANY_NAME = 'Viva Luzern';
export const VIVA_LUZERN_COMPANY_DOMAIN = 'viva-luzern.ch';

const parser = createProspectiveChParser({
  companyKey: VIVA_LUZERN_KEY,
  companyName: VIVA_LUZERN_COMPANY_NAME,
  companyDomain: VIVA_LUZERN_COMPANY_DOMAIN,
  mediumId: '1002590',
  apiLang: 'de',
  defaultCanton: 'LU',
  defaultCity: 'Luzern',
  defaultPostalCode: '6004',
  publicCareerUrl: 'https://www.viva-luzern.ch/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllVivaLuzernJobs = parser.fetchAllJobs;
export const isVivaLuzernJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
