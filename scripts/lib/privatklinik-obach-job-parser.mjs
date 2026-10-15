#!/usr/bin/env node
/**
 * Privatklinik Obach (Solothurn, SO) — SMN clinic PKO.
 *
 * Acute private hospital of Swiss Medical Network in Solothurn.
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKO
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 * Address verified against the public clinic page
 * https://www.swissmedical.net/de/spitaeler/obach
 * (Leopoldstrasse 5, 4500 Solothurn).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const PRIVATKLINIK_OBACH_KEY = 'privatklinik-obach';
export const PRIVATKLINIK_OBACH_COMPANY_NAME = 'Privatklinik Obach';
export const PRIVATKLINIK_OBACH_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: PRIVATKLINIK_OBACH_KEY,
  companyName: PRIVATKLINIK_OBACH_COMPANY_NAME,
  clinicCode: 'PKO',
  companyDomain: PRIVATKLINIK_OBACH_COMPANY_DOMAIN,
  defaultCanton: 'SO',
  defaultCity: 'Solothurn',
  defaultPostalCode: '4500',
  streetAddress: 'Leopoldstrasse 5, 4500 Solothurn',
  publicCareerUrl: 'https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKO',
  defaultSourceLang: 'de',
});

export const fetchAllPrivatklinikObachJobs = parser.fetchAllJobs;
export const isPrivatklinikObachJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
export const matchesPrivatklinikObachPosting = parser.matchesClinicPosting;
export const PRIVATKLINIK_OBACH_LISTING_URL = parser.LISTING_URL;
