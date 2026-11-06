#!/usr/bin/env node
/**
 * Sanatorium Kilchberg (ZH) job parser — Umantis tenant 3010 ("jobs@sani").
 *
 * Public career site: https://www.sanatorium-kilchberg.jobs/freie-stellen/
 * Raw listing:        https://recruitingapp-3010.umantis.com/Jobs/All?lang=ger
 *
 * Sanatorium Kilchberg is a private psychiatric / psychotherapy clinic
 * on the western shore of Lake Zurich (8802 Kilchberg ZH), part of the
 * Sanatorium Kilchberg AG group. ~600 employees, specialised in
 * mood disorders, psychiatry, psychosomatics and psychotherapy.
 *
 * The Umantis tenant 3010 ("jobs@sani") is used exclusively by Sanatorium
 * Kilchberg — every vacancy detail page shows the Kilchberg employer
 * on the listing, verified via spot-checks on /Vacancies/{id}/Description/1.
 *
 * Older Umantis UI (pipe-separated text rows).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const SANATORIUM_KILCHBERG_KEY = 'sanatorium-kilchberg';
export const SANATORIUM_KILCHBERG_COMPANY_NAME = 'Sanatorium Kilchberg';
export const SANATORIUM_KILCHBERG_COMPANY_DOMAIN = 'sanatorium-kilchberg.ch';

const parser = createUmantisListingParser({
  companyKey: SANATORIUM_KILCHBERG_KEY,
  companyName: SANATORIUM_KILCHBERG_COMPANY_NAME,
  companyDomain: SANATORIUM_KILCHBERG_COMPANY_DOMAIN,
  tenantId: 3010,
  lang: 'ger',
  defaultCanton: 'ZH',
  defaultCity: 'Kilchberg',
  defaultPostalCode: '8802',
  publicCareerUrl: 'https://www.sanatorium-kilchberg.jobs/freie-stellen/',
  defaultSourceLang: 'de',
});

export const fetchAllSanatoriumKilchbergJobs = parser.fetchAllJobs;
export const isSanatoriumKilchbergJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
