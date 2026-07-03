#!/usr/bin/env node
/**
 * Groupe E job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site: https://job.groupe-e.ch/
 * SF tenant code:      GroupeE
 *
 * NOTE: the source company table tagged this row url='jobup.ch (feed)',
 * ats='Custom (jobup.ch affiliate)' — VERIFIED WRONG via live discovery
 * (2026-07-04). Groupe E's real careers site is job.groupe-e.ch, a standard
 * SAP SuccessFactors Career Site Builder instance — the same platform
 * already used by ZURZACH Care, SIX Group, Helsana, Bachem, Idorsia,
 * Medartis, Octapharma and Tecan (see
 * `scripts/lib/successfactors-shared-job-parser-common.mjs`). It is NOT a
 * jobup.ch-exclusive feed. (This mirrors the EVAM Vaud precedent — same
 * table tag, actually Teamtailor — confirming the table's jobup.ch/Custom
 * tag is not reliable for this row either.)
 *
 * Groupe E is a Fribourg-based regional energy/utility company (electricity
 * production and distribution, district heating, gas, e-mobility,
 * engineering) headquartered in Granges-Paccot (FR). Postings span multiple
 * cantons in Suisse romande (FR/VD/NE/GE/VS/BE observed live), so the
 * shared factory's per-job location parsing (falling back to the FR HQ only
 * when a listing has no usable city) is relied upon, same as ZURZACH Care's
 * multi-canton pattern.
 *
 * CSB detail pages here render location as "City, <full canton name>, CH"
 * (e.g. "Fribourg, Fribourg, CH") rather than the 2-letter-region format
 * (`City, XX, CH`) the shared `parseCsbDetailPage` regex expects — so
 * `region`/`postalCode` from the detail page are empty for every job here,
 * and resolution falls through to `inferSwissTargetCanton(city)` (real
 * per-job canton, from the city name) and `defaultPostalCode` (HQ fallback)
 * respectively — same fallback chain ZURZACH Care already relies on.
 *
 * Uses the shared SuccessFactors factory — see
 * scripts/lib/successfactors-shared-job-parser-common.mjs.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const GROUPE_E_KEY = 'groupe-e';
export const GROUPE_E_COMPANY_NAME = 'Groupe E';
export const GROUPE_E_COMPANY_DOMAIN = 'groupe-e.ch';

const parser = createSuccessFactorsParser({
  companyKey: GROUPE_E_KEY,
  companyName: GROUPE_E_COMPANY_NAME,
  companyDomain: GROUPE_E_COMPANY_DOMAIN,
  sfCompanyId: 'GroupeE',
  publicCareerUrl: 'https://job.groupe-e.ch',
  defaultCanton: 'FR',
  defaultCity: 'Granges-Paccot',
  defaultPostalCode: '1763',
  defaultSourceLang: 'fr',
  sourceLabel: 'Groupe E Dedicated Parser (SuccessFactors CSB)',
  sector: 'Energia / Utility',
  fallbackCategory: 'Tecnica',
});

export const fetchAllGroupeEJobs = parser.fetchAllJobs;
export const isGroupeEJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
