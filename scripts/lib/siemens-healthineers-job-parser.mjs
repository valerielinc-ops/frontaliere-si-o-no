#!/usr/bin/env node
/**
 * Siemens Healthineers job parser — Workday (tenant `onehealthineers`, site SHSJB).
 *
 * ATS discovery (issue #3797 false-negative fix): the previous parser scraped
 * `careers.siemens-healthineers.com` (a Phenom People front-end) with a
 * `location=Switzerland&radius=100` query string. That query silently returns
 * `totalHits: 0` for ANY location text (Zug, Steinhausen, Schweiz, CH, "Zurich,
 * Switzerland" — all 0; only an EMPTY location returns the real ~420-job
 * board), which is why the crawler always found 0 Swiss jobs even though the
 * board is very much alive. Inspecting a sample Phenom listing's `applyUrl`
 * shows it forwards to `onehealthineers.wd3.myworkdayjobs.com/SHSJB/...` — the
 * Phenom page is a wrapper; the real backing ATS is Workday. Confirmed via
 * direct CXS API call: `locationCountry` facet (standard Swiss UUID) returns
 * a genuine small CH-scoped board (Workday's own `country.descriptor` on the
 * detail payload reads "Switzerland").
 *
 * Public careers: https://careers.siemens-healthineers.com/
 * Workday CXS API: https://onehealthineers.wd3.myworkdayjobs.com/wday/cxs/onehealthineers/SHSJB/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * Default canton ZH / city Zurich (matches existing company registry entry;
 * Workday's own location codes for these postings are internal facility
 * codes with no resolvable Swiss municipality, e.g. "DWL T").
 *
 * Exports 4 required functions crawler template:
 * - fetchAllSiemensHealthineersJobs() — Fetch + parse all Swiss jobs
 * - isSiemensHealthineersJob() — Match jobs belonging to company
 * - isTrustedDomain() — Validate URLs belong to company
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const SIEMENS_HEALTHINEERS_KEY = 'siemens-healthineers';
export const SIEMENS_HEALTHINEERS_COMPANY_NAME = 'Siemens Healthineers';
export const SIEMENS_HEALTHINEERS_COMPANY_DOMAIN = 'siemens-healthineers.com';

const parser = createWorkdaySwissParser({
  companyKey: SIEMENS_HEALTHINEERS_KEY,
  companyName: SIEMENS_HEALTHINEERS_COMPANY_NAME,
  companyDomain: SIEMENS_HEALTHINEERS_COMPANY_DOMAIN,
  tenantHost: 'onehealthineers.wd3.myworkdayjobs.com',
  sitePath: 'SHSJB',
  careerUrl: 'https://careers.siemens-healthineers.com/',
  defaultCanton: 'ZH',
  defaultCity: 'Zurich',
  sector: 'Sanità / Medicale',
  defaultSourceLang: 'en',
});

export const fetchAllSiemensHealthineersJobs = parser.fetchAllJobs;
export const isSiemensHealthineersJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
