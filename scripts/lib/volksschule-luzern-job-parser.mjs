#!/usr/bin/env node
/**
 * Volksschule Stadt Luzern job parser — Prospective.ch (medium 1005619).
 *
 * Volksschule Stadt Luzern is the City of Lucerne's public school network
 * (kindergarten, Basisstufe, primary and secondary school, plus the
 * associated music school and school-support/social-work roles). The public
 * job portal (https://jobs.stadtluzern.ch/stellen/offene-stellen-volks-und-musikschule/)
 * embeds a Prospective.ch careercenter served from job.stadtluzern.ch, which
 * in turn resolves to the Prospective v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1005619/jobs?lang=de
 *
 * Tenant ID confirmed live: the careercenter asset paths on
 * job.stadtluzern.ch embed `/careercenter/1005619/...`, and the API response
 * for medium 1005619 returns real Stadt Luzern school postings (e.g.
 * "Stellvertretung als Klassenlehrperson ... Schulhaus Wartegg").
 *
 * Rektorat Volksschule (operative HQ): Winkelriedstrasse 12a, 6002 Luzern.
 * Canton LU. Most postings carry their own school-building street/ZIP via
 * `sza_location.street` / `sza_location.zip` — the HQ address is only a
 * fallback for postings that omit those fields.
 *
 * Uses shared Prospective.ch factory. Sector overridden to 'Istruzione'
 * (education) — the factory defaults to a healthcare sector/category because
 * every other Prospective tenant onboarded so far is a hospital/clinic.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const VOLKSSCHULE_LUZERN_KEY = 'volksschule-luzern';
export const VOLKSSCHULE_LUZERN_COMPANY_NAME = 'Volksschule Stadt Luzern';
export const VOLKSSCHULE_LUZERN_COMPANY_DOMAIN = 'stadtluzern.ch';

const SECTOR = 'Istruzione';

/**
 * Category classifier for a school-district tenant. Mirrors the
 * education-sector labelling convention used by other school/university
 * dedicated crawlers (e.g. franklin-university-job-parser.mjs's
 * 'Istruzione / Universita'), scoped down to the non-teaching support roles
 * a Volksschule also posts (social work, admin, facilities).
 */
function detectVolksschuleCategory(title = '') {
  const t = String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/schulsozialarbeit|sozialarbeit|sozialpaedagog/.test(t)) return 'Sociale / Educazione';
  if (/hausdienst|hauswart|reinigung|abwart/.test(t)) return 'Tecnica';
  if (/sekretariat|administration|sachbearbeit|schulverwaltung/.test(t)) return 'Amministrazione';
  if (/praktik|stagiaire|lernende|auszubildende/.test(t)) return 'Formazione';
  return 'Istruzione';
}

const parser = createProspectiveChParser({
  companyKey: VOLKSSCHULE_LUZERN_KEY,
  companyName: VOLKSSCHULE_LUZERN_COMPANY_NAME,
  companyDomain: VOLKSSCHULE_LUZERN_COMPANY_DOMAIN,
  mediumId: '1005619',
  apiLang: 'de',
  defaultCanton: 'LU',
  defaultCity: 'Luzern',
  defaultPostalCode: '6002',
  publicCareerUrl: 'https://jobs.stadtluzern.ch/stellen/offene-stellen-volks-und-musikschule/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.stadtluzern.ch', 'job.stadtluzern.ch', 'stadtluzern.prospective.ch'],
  sector: SECTOR,
  categoryFn: detectVolksschuleCategory,
});

export const fetchAllVolksschuleLuzernJobs = parser.fetchAllJobs;
export const isVolksschuleLuzernJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
