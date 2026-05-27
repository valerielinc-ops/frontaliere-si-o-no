#!/usr/bin/env node
/**
 * Medics Labor AG (Bern) job parser — Refline ATS tenant 1474 on
 * app.reflinejobs.io.
 *
 * Medics Labor is the laboratory-diagnostics arm of the Medics medical-care
 * network (medics.ch / medics-labor.ch). Headquartered in Bern, it operates
 * one of the largest private medical laboratories in Switzerland with
 * specialised units in haematology, microbiology, clinical chemistry,
 * immunology and laboratory IT.
 *
 * Public career site:
 *   https://www.medics.ch/             (corporate)
 *   https://www.medics-labor.ch/       (redirects to www.medics.ch)
 *   Refline widget embeds:
 *     https://app.reflinejobs.io/1474/positions.html?lang=de
 *
 * Listing format: anchor-list
 *   <a href="https://app.reflinejobs.io/1474/{posId}/pub/{rev}/index.html">Title</a>
 *
 * Detail page: <h1 class="posTitle">Title</h1> + Bern address blocks.
 */
import { createReflineParser } from './refline-common.mjs';

export const MEDICS_LABOR_KEY = 'medics-labor';
export const MEDICS_LABOR_COMPANY_NAME = 'Medics Labor AG';
export const MEDICS_LABOR_COMPANY_DOMAIN = 'medics.ch';

const parser = createReflineParser({
  reflineTenant: '1474',
  companyKey: MEDICS_LABOR_KEY,
  companyName: MEDICS_LABOR_COMPANY_NAME,
  companyDomain: MEDICS_LABOR_COMPANY_DOMAIN,
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3001',
  publicCareerUrl: 'https://www.medics.ch/',
  defaultSourceLang: 'de',
  listingHost: 'app.reflinejobs.io',
  sector: 'Sanità / Ospedali',
  sourceLabel: 'Medics Labor Dedicated Parser (Refline 1474)',
});

export const fetchAllMedicsLaborJobs = parser.fetchAllJobs;
export const isMedicsLaborJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
