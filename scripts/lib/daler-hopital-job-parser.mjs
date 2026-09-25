#!/usr/bin/env node
/**
 * Hôpital Daler (Fribourg) — private acute hospital founded in 1929,
 * specialised in maternity / gynaecology and ambulatory surgery on the
 * Fribourg Daler campus (1700 Fribourg, FR).
 *
 * Public corporate career page:
 *   https://daler.ch/emplois/
 *
 * The corporate page embeds the Johdi Suite widget; the actual job data
 * lives behind the standard Johdi Suite public API. See
 * `scripts/lib/johdisuite-common.mjs` for ATS details.
 *
 * `companyHashKey` was lifted from the widget mount node on the public
 * /emplois/ page (May 2026):
 *   <div id="ats-offers" data-locale="fr"
 *        data-company-hash-key="eyJpdiI6..." data-flow="web">
 * It is an encrypted Laravel payload that identifies the tenant — STABLE
 * across deploys; refresh only if Daler ever rotates the key.
 */
import { createJohdiSuiteParser } from './johdisuite-common.mjs';

export const DALER_KEY = 'daler-hopital';
export const DALER_COMPANY_NAME = 'Hôpital Daler';
export const DALER_COMPANY_DOMAIN = 'daler.ch';

// Lifted from https://daler.ch/emplois/ — the `data-company-hash-key`
// on the `#ats-offers` widget container (May 2026).
const COMPANY_HASH_KEY = 'eyJpdiI6Im9rUTBMYk1NZm1uTVdRM1pDUldvT3c9PSIsInZhbHVlIjoiUVVadGU0WXE2SjhLSEM3ejl5VXZvdz09IiwibWFjIjoiNTdkYjc1NDBkNDk3MWQyMWZjZjg1MmQ4YjY1ZjY4MWI4ZGQ1NmU4MzgyMWExMjA5OWIzZjg4YzU5ZGRkYmI2ZCIsInRhZyI6IiJ9';

const parser = createJohdiSuiteParser({
  companyKey: DALER_KEY,
  companyName: DALER_COMPANY_NAME,
  companyDomain: DALER_COMPANY_DOMAIN,
  companyHashKey: COMPANY_HASH_KEY,
  publicationFlow: 'web',
  locale: 'fr',
  publicCareerUrl: 'https://daler.ch/emplois/',
  defaultCanton: 'FR',
  defaultCity: 'Fribourg',
  defaultPostalCode: '1700',
  sourceLabel: 'Hôpital Daler Dedicated Parser (Johdi Suite)',
  fallbackBrandBlurb:
    "L'Hôpital Daler, fondé en 1929 à Fribourg, est un hôpital privé reconnu d'intérêt public, spécialisé en gynécologie, obstétrique, chirurgie ambulatoire et soins de proximité. Au cœur de Fribourg, il accueille chaque année plus de 1'500 naissances et compte plus de 350 collaboratrices et collaborateurs.",
});

export const fetchAllDalerJobs = parser.fetchAllJobs;
export const isDalerJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
