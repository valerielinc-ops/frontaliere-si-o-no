#!/usr/bin/env node
/**
 * asana Spital AG (Spital Menziken + Spital Leuggern) job parser
 * — Prospective.ch medium 1005771.
 *
 * Background:
 *   asana Spital AG is the umbrella entity running two Aargau regional acute
 *   hospitals — Spital Menziken (Wiggertal / lower Aargau, AG 5737) and
 *   Spital Leuggern (Aare-Rhine / north Aargau, AG 5316). Both share the same
 *   Prospective tenant (1005771) but each posting links back to its respective
 *   single-site hostname (`jobs.spitalmenziken.ch` or `jobs.spitalleuggern.ch`).
 *
 *   Spital Muri (the third hospital sometimes affiliated with the asana
 *   network) is intentionally NOT included here — Muri runs its own dedicated
 *   parser (`spital-muri-job-parser.mjs`) and a different ATS tenant.
 *
 * Public career site(s):
 *   - https://www.spitalmenziken.ch/karriere
 *   - https://www.spitalleuggern.ch/karriere
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1005771/jobs?lang=de
 *
 * Canton AG, default city Menziken (postal 5737) — per-job location is
 * resolved by the shared factory against the BFS municipality table so
 * Leuggern (5316) postings also get the right canton/postal code.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const ASANA_SPITAL_KEY = 'asana-spital';
export const ASANA_SPITAL_COMPANY_NAME = 'asana Spital AG (Menziken / Leuggern)';
export const ASANA_SPITAL_COMPANY_DOMAIN = 'asana-gruppe.ch';

const parser = createProspectiveChParser({
  companyKey: ASANA_SPITAL_KEY,
  companyName: ASANA_SPITAL_COMPANY_NAME,
  companyDomain: ASANA_SPITAL_COMPANY_DOMAIN,
  mediumId: '1005771',
  apiLang: 'de',
  defaultCanton: 'AG',
  defaultCity: 'Menziken',
  defaultPostalCode: '5737',
  publicCareerUrl: 'https://www.spitalmenziken.ch/karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'spitalmenziken.ch',
    'jobs.spitalmenziken.ch',
    'spitalleuggern.ch',
    'jobs.spitalleuggern.ch',
    'asana-gruppe.ch',
  ],
});

export const fetchAllAsanaSpitalJobs = parser.fetchAllJobs;
export const isAsanaSpitalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
