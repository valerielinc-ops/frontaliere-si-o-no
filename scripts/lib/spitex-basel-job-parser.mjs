#!/usr/bin/env node
/**
 * SPITEX BASEL job parser — Prospective.ch (medium 1008423).
 *
 * SPITEX BASEL is a non-profit foundation with a public-service mandate from
 * the Canton of Basel-Stadt providing ambulant nursing, household and care
 * services to children, adolescents and adults across the city.
 *
 * Public career site (CMS iframe wrapper):
 *   https://www.spitexbasel.ch/Stellen-und-Bildung/Offene-Stellen/
 *     → embeds iframe to https://jobs.spitexbasel.ch/
 *       (Prospective careercenter 1008423)
 *
 * The careercenter ID matches the Prospective v1 listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1008423/jobs?lang=de
 *
 * Canton BS, postal 4051 (Friedrich Miescher-Strasse 30, Basel).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SPITEX_BASEL_KEY = 'spitex-basel';
export const SPITEX_BASEL_COMPANY_NAME = 'SPITEX BASEL';
export const SPITEX_BASEL_COMPANY_DOMAIN = 'spitexbasel.ch';

const parser = createProspectiveChParser({
  companyKey: SPITEX_BASEL_KEY,
  companyName: SPITEX_BASEL_COMPANY_NAME,
  companyDomain: SPITEX_BASEL_COMPANY_DOMAIN,
  mediumId: '1008423',
  apiLang: 'de',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4051',
  publicCareerUrl: 'https://www.spitexbasel.ch/Stellen-und-Bildung/Offene-Stellen/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.spitexbasel.ch', 'www.spitexbasel.ch'],
});

/**
 * SPITEX BASEL specific quirk: this tenant uses Prospective `attribute[10]`
 * for a *profession category* (e.g. "Pflege", "Weitere Berufsgruppen")
 * rather than a city/site label. The shared factory falls back to that field
 * when `sza_location.city` is empty, which produces a category-as-location.
 *
 * All SPITEX BASEL positions are physically based in the city of Basel
 * (Kanton Basel-Stadt, single-municipality canton), so we normalize the
 * locality fields to the defaults without touching the shared factory.
 */
async function fetchAllSpitexBaselJobs() {
  const jobs = await parser.fetchAllJobs();
  return jobs.map((j) => ({
    ...j,
    location: 'Basel',
    addressLocality: 'Basel',
    addressRegion: 'BS',
    canton: 'BS',
    postalCode: j.postalCode || '4051',
  }));
}

export { fetchAllSpitexBaselJobs };
export const isSpitexBaselJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
