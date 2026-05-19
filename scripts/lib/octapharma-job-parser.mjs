#!/usr/bin/env node
/**
 * Octapharma job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://careers.octapharma.com/
 * SF tenant code:      Octapharma
 *
 * Octapharma is a global, privately-owned plasma-derived medicine
 * manufacturer headquartered in Lachen (SZ), Switzerland. The Swiss
 * site hosts the executive team and the IBU Critical Care / Hematology
 * teams. ~8 open positions in CH at any given time.
 *
 * The career portal is a public CSB instance with a `/search` listing
 * endpoint — see `scripts/lib/successfactors-shared-job-parser-common.mjs`
 * for the platform details.
 *
 * Notes:
 *   - `searchParams: { locationsearch: 'Switzerland' }` restricts the
 *     server-side query to CH jobs (Octapharma is a multi-country group
 *     with sites in DE / SE / AT / FR / US plus the Swiss HQ).
 *   - Detail pages expose the standard `title` / `location` / `description`
 *     CSB propertyids; the factory handles them directly.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const OCTAPHARMA_KEY = 'octapharma';
export const OCTAPHARMA_COMPANY_NAME = 'Octapharma';
export const OCTAPHARMA_COMPANY_DOMAIN = 'octapharma.com';

const parser = createSuccessFactorsParser({
  companyKey: OCTAPHARMA_KEY,
  companyName: OCTAPHARMA_COMPANY_NAME,
  companyDomain: OCTAPHARMA_COMPANY_DOMAIN,
  sfCompanyId: 'Octapharma',
  publicCareerUrl: 'https://careers.octapharma.com',
  defaultCanton: 'SZ',
  defaultCity: 'Lachen',
  defaultPostalCode: '8853',
  defaultSourceLang: 'de',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'Octapharma Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllOctapharmaJobs = parser.fetchAllJobs;
export const isOctapharmaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
