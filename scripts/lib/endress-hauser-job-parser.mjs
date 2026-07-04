#!/usr/bin/env node
/**
 * Endress+Hauser job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://careers.endress.com/
 * SF tenant code:      endress (see `career_company=endress` query param on
 *                       the SF-hosted `career5.successfactors.eu` sign-in link
 *                       embedded in the public career-site page).
 *
 * Endress+Hauser is a Swiss industrial-instrumentation group headquartered in
 * Reinach (BL) — measurement instrumentation, automation solutions and
 * services for the process industry (level, flow, pressure, temperature,
 * analytics). Global group with sub-brands (e.g. Analytik Jena) and listings
 * across many countries; ~36 open CH roles observed live, all in Reinach BL.
 *
 * The career portal is a public CSB instance with a `/search` listing
 * endpoint — see `scripts/lib/successfactors-shared-job-parser-common.mjs`
 * for the platform details.
 *
 * Notes:
 *   - `searchParams: { locationsearch: 'Switzerland' }` restricts the
 *     server-side query to CH jobs (Endress+Hauser's global portal lists
 *     US/EU/APAC sites plus sub-brand listings like Analytik Jena).
 *   - Unlike most other CSB tenants wired to this factory, Endress+Hauser
 *     prefixes job links with a country/brand path segment instead of a flat
 *     `/job/...` link, e.g. `/Switzerland/job/{slug}/{jobId}/` or
 *     `/analytik-jena/job/{slug}/{jobId}/`. `parseCsbSearchResults()` in the
 *     shared factory was extended (additive, optional path segment) to match
 *     both shapes.
 *   - Detail pages only expose a `description` propertyid + schema.org
 *     microdata (`itemprop="jobLocation"` etc., no `location` propertyid
 *     block) — the factory falls back to listing-cell location parsing via
 *     the dedicated `colLocation` `<td>` (same fallback path as Bachem).
 *   - `sector`/`descriptionFallbackTagline` overrides keep the (rare,
 *     thin-description-only) boilerplate text and category-adjacent sector
 *     label accurate for an industrial-instrumentation tenant instead of the
 *     factory's healthcare-tenant-origin defaults.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const ENDRESS_HAUSER_KEY = 'endress-hauser';
export const ENDRESS_HAUSER_COMPANY_NAME = 'Endress+Hauser';
export const ENDRESS_HAUSER_COMPANY_DOMAIN = 'endress.com';

const parser = createSuccessFactorsParser({
  companyKey: ENDRESS_HAUSER_KEY,
  companyName: ENDRESS_HAUSER_COMPANY_NAME,
  companyDomain: ENDRESS_HAUSER_COMPANY_DOMAIN,
  sfCompanyId: 'endress',
  publicCareerUrl: 'https://careers.endress.com',
  defaultCanton: 'BL',
  defaultCity: 'Reinach',
  defaultPostalCode: '4153',
  defaultSourceLang: 'de',
  searchParams: { locationsearch: 'Switzerland' },
  sector: 'Strumentazione industriale / Automazione',
  categoryFallback: 'Strumentazione industriale / Automazione',
  descriptionFallbackTagline:
    'ist ein globaler Marktführer für Messtechnik und Automatisierungslösungen für die Prozessindustrie',
  sourceLabel: 'Endress+Hauser Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllEndressHauserJobs = parser.fetchAllJobs;
export const isEndressHauserJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
