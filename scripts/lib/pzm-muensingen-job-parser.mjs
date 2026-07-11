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
 *
 * 2026-07 merger note: pzmag.ch/karriere now 301-redirects to
 * upz-bern.ch/karriere — PZM merged with UPD Bern into "Universitäres
 * Psychiatrisches Zentrum Bern (UPZ)". Every listing on medium 1008606 now
 * carries a generic `ohws.prospective.ch/public/v1/jobs/{id}` directlink
 * instead of a `jobs.pzmag.ch` one, so `acceptDirectlinkHosts` below
 * legitimately filters out 100% of postings (0 is correct, not broken —
 * see `EMPTY_OK_CRAWLERS` in `scripts/check-crawler-health.mjs`). Former PZM
 * roles are already covered by `upd-job-parser.mjs` (Umantis tenant 2908),
 * which now lists the full merged UPZ vacancy set including
 * Münsingen-located roles. This dedicated crawler is a candidate for
 * retirement (issue #4080) — deferred because that requires editing
 * `.github/workflows/crawler-group-10.yml`.
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
  // Prospective tenant 1008606 is shared with Universitäre Psychiatrische
  // Dienste Bern (UPD) — 61 of 86 listings carry jobs.upd.ch directlinks.
  // UPD has its own dedicated crawler; filter them out here.
  acceptDirectlinkHosts: ['jobs.pzmag.ch'],
});

export const fetchAllPzmMuensingenJobs = parser.fetchAllJobs;
export const isPzmMuensingenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
