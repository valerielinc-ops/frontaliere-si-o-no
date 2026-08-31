#!/usr/bin/env node
/**
 * Privatklinik Bethanien (Zürich, ZH) — SMN clinic PKB.
 *
 * Acute private hospital of Swiss Medical Network in Zürich. Listing
 * endpoint:
 *
 *   https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKB
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 * Address verified against the public clinic page
 * https://www.swissmedical.net/de/spitaeler/bethanien
 * (Toblerstrasse 51, 8044 Zürich).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const PRIVATKLINIK_BETHANIEN_KEY = 'privatklinik-bethanien';
export const PRIVATKLINIK_BETHANIEN_COMPANY_NAME = 'Privatklinik Bethanien';
export const PRIVATKLINIK_BETHANIEN_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: PRIVATKLINIK_BETHANIEN_KEY,
  companyName: PRIVATKLINIK_BETHANIEN_COMPANY_NAME,
  clinicCode: 'PKB',
  companyDomain: PRIVATKLINIK_BETHANIEN_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8044',
  streetAddress: 'Toblerstrasse 51, 8044 Zürich',
  publicCareerUrl: 'https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKB',
  defaultSourceLang: 'de',
});

export const fetchAllPrivatklinikBethanienJobs = parser.fetchAllJobs;
export const isPrivatklinikBethanienJob = parser.isCompanyJob;
export const matchesPrivatklinikBethanienPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const PRIVATKLINIK_BETHANIEN_LISTING_URL = parser.LISTING_URL;
