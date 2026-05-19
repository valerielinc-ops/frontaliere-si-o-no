#!/usr/bin/env node
/**
 * Psychiatriezentrum Münsingen AG (PZM) job parser
 * — Prospective.ch medium 1008606.
 *
 * Background:
 *   Psychiatriezentrum Münsingen (PZM) is one of the two large psychiatric
 *   clinics in the canton of Bern (alongside UPD Bern, already covered).
 *   ~86 open positions across psychiatric nursing (Pflege ICM/IDM),
 *   medicine, therapy, social-pedagogical and administration roles.
 *
 *   Distinct from `upd-job-parser.mjs` (Universitäre Psychiatrische Dienste
 *   Bern), `klinik-lengg-job-parser.mjs` (Zürich epilepsy clinic) and
 *   `privatklinik-meiringen-job-parser.mjs` (private BE psychiatric).
 *
 * Public career site: https://www.pzmag.ch/karriere
 *   → iframes a Prospective careercenter (1008606). Apply backend is
 *     pi-asp.de (SAP HR vendor) but the listing API is Prospective.
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1008606/jobs?lang=de
 *
 * Canton BE, postal 3110 (Münsingen).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const PZM_MUENSINGEN_KEY = 'pzm-muensingen';
export const PZM_MUENSINGEN_COMPANY_NAME = 'Psychiatriezentrum Münsingen';
export const PZM_MUENSINGEN_COMPANY_DOMAIN = 'pzmag.ch';

const parser = createProspectiveChParser({
  companyKey: PZM_MUENSINGEN_KEY,
  companyName: PZM_MUENSINGEN_COMPANY_NAME,
  companyDomain: PZM_MUENSINGEN_COMPANY_DOMAIN,
  mediumId: '1008606',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Münsingen',
  defaultPostalCode: '3110',
  publicCareerUrl: 'https://www.pzmag.ch/karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'pzmag.ch',
    'jobs.pzmag.ch',
    'pzm.pi-asp.de',
  ],
});

export const fetchAllPzmMuensingenJobs = parser.fetchAllJobs;
export const isPzmMuensingenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
