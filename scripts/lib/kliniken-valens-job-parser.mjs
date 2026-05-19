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
  publicCareerUrl: 'https://valens.ch/karriere/offene-stellen/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['valens.ch', 'jobs.kliniken-valens.ch', 'blitzbewerbung.kliniken-valens.ch'],
});

export const fetchAllKlinikenValensJobs = parser.fetchAllJobs;
export const isKlinikenValensJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
