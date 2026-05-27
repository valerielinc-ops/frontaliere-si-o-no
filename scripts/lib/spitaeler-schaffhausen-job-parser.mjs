#!/usr/bin/env node
/**
 * Spitäler Schaffhausen job parser — Prospective.ch (medium 1008352).
 *
 * Public career site: https://www.spitaeler-sh.ch/offene-stellen
 *   → embeds iframe to https://stellen.spitaeler-sh.ch/ (Prospective careercenter 1008352)
 *
 * The careercenter and the public v1 JSON listing endpoint share the same ID:
 *   https://ohws.prospective.ch/public/v1/medium/1008352/jobs?lang=de
 *
 * Spitäler Schaffhausen AG covers the Kantonsspital Schaffhausen, the
 * Psychiatriezentrum Breitenau and the KJPD — ~60 open positions in
 * medicine, nursing, allied therapies and administration. Canton SH.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SPITAELER_SCHAFFHAUSEN_KEY = 'spitaeler-schaffhausen';
export const SPITAELER_SCHAFFHAUSEN_COMPANY_NAME = 'Spitäler Schaffhausen';
export const SPITAELER_SCHAFFHAUSEN_COMPANY_DOMAIN = 'spitaeler-sh.ch';

const parser = createProspectiveChParser({
  companyKey: SPITAELER_SCHAFFHAUSEN_KEY,
  companyName: SPITAELER_SCHAFFHAUSEN_COMPANY_NAME,
  companyDomain: SPITAELER_SCHAFFHAUSEN_COMPANY_DOMAIN,
  mediumId: '1008352',
  apiLang: 'de',
  defaultCanton: 'SH',
  defaultCity: 'Schaffhausen',
  defaultPostalCode: '8208',
  publicCareerUrl: 'https://www.spitaeler-sh.ch/offene-stellen',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['stellen.spitaeler-sh.ch', 'jobs.spitaeler-sh.ch'],
});

export const fetchAllSpitaelerSchaffhausenJobs = parser.fetchAllJobs;
export const isSpitaelerSchaffhausenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
