#!/usr/bin/env node
/**
 * NSN Medical Group job parser — Umantis tenant 2884.
 *
 * NSN medical AG (https://nsn.ch/) is a Zürich-based medical services group
 * whose career portal hosts open positions for several affiliated entities
 * under a single Umantis tenant:
 *   - NSN medical AG            (group HQ, Zürich)
 *   - Zentrum für integrative Onkologie (ZIO) — Zürichsee, Zürich-Oerlikon
 *   - narkose.ch                (mobile anaesthesia, Raum Zürich/Winterthur)
 *   - Limmatklinik              (acute private clinic, Zürich) — linked via nsn.ch/jobs/
 *   - Eulachklinik Winterthur   (acute private clinic, Winterthur) — linked via nsn.ch/jobs/
 *
 * Public career hub: https://nsn.ch/jobs/
 *   → iframes / embeds  https://recruitingapp-2884.umantis.com/Jobs/All?lang=ger
 *
 * Older Umantis UI (`tableaslist_contentrow{1|2}`): the per-row company name is
 * surfaced in `tableaslist_element_1152486` (first text span); the parser
 * factory picks that up as `entry.companyValue`. Region label is always
 * "Region Zürich" — `inferSwissTargetCanton()` resolves to ZH.
 *
 * Both Limmatklinik (www.limmatklinik.ch) and Eulachklinik (eulachklinik.ch)
 * point their public "Jobs" CTA to https://nsn.ch/jobs/, so this single parser
 * is the canonical entry point for the whole NSN Medical group regardless of
 * which sister site advertises a vacancy.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const NSN_MEDICAL_KEY = 'nsn-medical';
export const NSN_MEDICAL_COMPANY_NAME = 'NSN Medical Group';
export const NSN_MEDICAL_COMPANY_DOMAIN = 'nsn.ch';

const parser = createUmantisListingParser({
  companyKey: NSN_MEDICAL_KEY,
  companyName: NSN_MEDICAL_COMPANY_NAME,
  companyDomain: NSN_MEDICAL_COMPANY_DOMAIN,
  tenantId: 2884,
  lang: 'ger',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8001',
  publicCareerUrl: 'https://nsn.ch/jobs/',
  defaultSourceLang: 'de',
});

export const fetchAllNsnMedicalJobs = parser.fetchAllJobs;
export const isNsnMedicalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
