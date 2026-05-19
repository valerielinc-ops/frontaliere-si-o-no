#!/usr/bin/env node
/**
 * Universitäts-Kinderspital Zürich (Kispi) job parser — Umantis tenant 2316.
 *
 * Public career site: https://www.kispi.uzh.ch/jobs/offene-stellen
 *   The public site embeds job apply URLs at
 *   `https://atsconnector.prospective.ch/umantis/2316/de/apply/{ID}`
 *   which forwards to the raw listing at
 *   `https://recruitingapp-2316.umantis.com/Jobs/All?lang=ger`.
 *
 * Kispi is the largest children's hospital in Switzerland (Eleonorenstiftung,
 * affiliated with UZH) — ~3000 employees across the Lengg campus (Zürich-Hirslanden)
 * and the new Lengghalde building. Eleonorenstiftung is the operator.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const KISPI_ZURICH_KEY = 'kispi-zurich';
export const KISPI_ZURICH_COMPANY_NAME = 'Universitäts-Kinderspital Zürich (Kispi)';
export const KISPI_ZURICH_COMPANY_DOMAIN = 'kispi.uzh.ch';

const parser = createUmantisListingParser({
  companyKey: KISPI_ZURICH_KEY,
  companyName: KISPI_ZURICH_COMPANY_NAME,
  companyDomain: KISPI_ZURICH_COMPANY_DOMAIN,
  tenantId: 2316,
  lang: 'ger',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8032',
  publicCareerUrl: 'https://www.kispi.uzh.ch/jobs/offene-stellen',
  defaultSourceLang: 'de',
});

export const fetchAllKispiZurichJobs = parser.fetchAllJobs;
export const isKispiZurichJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
