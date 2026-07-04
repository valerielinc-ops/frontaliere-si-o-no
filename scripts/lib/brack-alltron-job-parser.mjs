#!/usr/bin/env node
/**
 * Brack.Alltron AG job parser — Prospective.ch (medium 1005615).
 *
 * Brack.Alltron is the Swiss e-commerce/electronics-distribution group
 * behind the consumer retailer BRACK.CH and the B2B distributor Alltron
 * (part of the Competec group). Public career site
 * https://jobs.brackalltron.ch/ (also reachable via jobs.brack.ch and
 * jobs.competec.ch, both redirecting to the same board) embeds a
 * Prospective.ch careercenter; the tenant ID matches the Prospective v1
 * JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1005615/jobs?lang=de
 *
 * Direct-employer sanity check (discovery flagged "jobs.ch (feed)" tags as
 * having produced 2 staffing-agency false positives in this campaign):
 * listings read as first-person employer copy ("Vergünstigungen im
 * Brack-Onlineshop", own "Academy" training program, own logistics center)
 * with zero "im Auftrag unseres Kunden" / agency-placement phrasing — this
 * is a genuine direct employer.
 *
 * Two real Swiss sites, both carried as HQ-grade defaults (used only when
 * the listing's own `sza_workplace`/`sza_location.zip` doesn't resolve):
 *  - Mägenwil (AG) — Hintermättlistrasse 3, 5506 Mägenwil (BRACK.CH HQ)
 *  - Willisau (LU) — Rossgassmoos 10, 6131 Willisau (Alltron logistics center)
 * `inferSwissTargetCanton()` resolves the correct canton per-listing from
 * the city text, so both sites map correctly without a custom region table.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const BRACK_ALLTRON_KEY = 'brack-alltron';
export const BRACK_ALLTRON_COMPANY_NAME = 'Brack.Alltron AG';
export const BRACK_ALLTRON_COMPANY_DOMAIN = 'brack.ch';

// Second real Swiss site — Alltron's Willisau logistics center. The shared
// factory's HQ-street fallback is single-site (gated to `defaultCity`), so
// Willisau listings would otherwise ship an empty `streetAddress` even
// though the real address is known. Backfilled below rather than fabricated
// for any other city.
const WILLISAU_POSTAL_CODE = '6131';
const WILLISAU_STREET_ADDRESS = 'Rossgassmoos 10';

const parser = createProspectiveChParser({
  companyKey: BRACK_ALLTRON_KEY,
  companyName: BRACK_ALLTRON_COMPANY_NAME,
  companyDomain: BRACK_ALLTRON_COMPANY_DOMAIN,
  mediumId: '1005615',
  apiLang: 'de',
  defaultCanton: 'AG',
  defaultCity: 'Mägenwil',
  defaultPostalCode: '5506',
  defaultStreetAddress: 'Hintermättlistrasse 3',
  publicCareerUrl: 'https://jobs.brackalltron.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'jobs.brackalltron.ch',
    'brackalltron.ch',
    'jobs.brack.ch',
    'jobs.competec.ch',
    'brack.ch',
    'alltron.ch',
    'competec.ch',
  ],
  sector: 'E-commerce / Distribuzione elettronica',
});

export async function fetchAllBrackAlltronJobs() {
  const jobs = await parser.fetchAllJobs();
  for (const job of jobs) {
    if (!job.streetAddress && job.postalCode === WILLISAU_POSTAL_CODE) {
      job.streetAddress = WILLISAU_STREET_ADDRESS;
    }
  }
  return jobs;
}
export const isBrackAlltronJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
