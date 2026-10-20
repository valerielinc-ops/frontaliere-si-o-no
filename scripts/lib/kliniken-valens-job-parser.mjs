#!/usr/bin/env node
/**
 * Kliniken Valens job parser — Prospective.ch (medium 1005103).
 *
 * Public career site: https://valens.ch/karriere/offene-stellen/
 * API:                https://ohws.prospective.ch/public/v1/medium/1005103/jobs
 *
 * Swiss specialist rehabilitation group operating multiple sites in eastern
 * Switzerland: Valens (SG), Walenstadtberg, Walzenhausen, Davos Clavadel
 * (former Zürcher RehaZentrum Davos), Pfäfers, and others.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const KLINIKEN_VALENS_KEY = 'kliniken-valens';
export const KLINIKEN_VALENS_COMPANY_NAME = 'Kliniken Valens';
export const KLINIKEN_VALENS_COMPANY_DOMAIN = 'kliniken-valens.ch';

const parser = createProspectiveChParser({
  companyKey: KLINIKEN_VALENS_KEY,
  companyName: KLINIKEN_VALENS_COMPANY_NAME,
  companyDomain: KLINIKEN_VALENS_COMPANY_DOMAIN,
  mediumId: '1005103',
  apiLang: 'de',
  defaultCanton: 'SG',
  defaultCity: 'Valens',
  defaultPostalCode: '7317',
  // Clinic sites the BFS municipality list cannot resolve by name: Valens
  // (ZIP 7317/7313, part of Pfäfers SG) and Walenstadtberg (ZIP 8881, part of
  // Walenstadt SG) are sub-municipal localities, and Wald exists in ZH, AR and
  // BE — the group's Wald site is the Zürcher RehaZentrum (ZIP 8636, region
  // "Zürcher Oberland"), which the old HQ fallback published as SG. Any other
  // unresolved location is dropped by the shared factory (issue 9844).
  siteCantons: { Valens: 'SG', Walenstadtberg: 'SG', Wald: 'ZH' },
  publicCareerUrl: 'https://valens.ch/karriere/offene-stellen/',
  defaultSourceLang: 'de',
  // Prospective directlink uses the `jobs.valens.ch` host (the corporate apex is
  // `kliniken-valens.ch` so the bare `valens.ch` apex match doesn't apply to the
  // jobs subdomain). The full set covers historical apply-form hosts as well.
  extraTrustedHosts: [
    'valens.ch',
    'jobs.valens.ch',
    'jobs.kliniken-valens.ch',
    'blitzbewerbung.kliniken-valens.ch',
  ],
});

export const fetchAllKlinikenValensJobs = parser.fetchAllJobs;
export const isKlinikenValensJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
