#!/usr/bin/env node
/**
 * Stiftung Kind und Autismus (Urdorf ZH) job parser — Refline ATS tenant 2044
 * on app.reflinejobs.io.
 *
 * The foundation is a competence centre for children and adolescents on the
 * autism spectrum in Urdorf (Bezirk Dietikon, ZH, postal 8902). Programmes
 * include a special-needs school (56 places), supported living (16 places),
 * transport service, advisory office, early-intervention unit, training
 * courses and a specialised aids shop. ~120 employees.
 *
 * Public career site:
 *   https://www.kind-autismus.ch/jobs/    (corporate, embeds Refline widget)
 *   https://app.reflinejobs.io/2044/positions.html?lang=de
 *
 * Listing format: anchor-list
 *   <a href="https://app.reflinejobs.io/2044/{posId}/pub/{rev}/index.html">Title</a>
 *
 * Detail page: <h1 class="posTitle"> + JSON-LD JobPosting with full address
 *   Bergstrasse 28, 8902 Urdorf, ZH.
 */
import { createReflineParser } from './refline-common.mjs';

export const STIFTUNG_KIND_AUTISMUS_KEY = 'stiftung-kind-autismus';
export const STIFTUNG_KIND_AUTISMUS_COMPANY_NAME = 'Stiftung Kind und Autismus';
export const STIFTUNG_KIND_AUTISMUS_COMPANY_DOMAIN = 'kind-autismus.ch';

const parser = createReflineParser({
  reflineTenant: '2044',
  companyKey: STIFTUNG_KIND_AUTISMUS_KEY,
  companyName: STIFTUNG_KIND_AUTISMUS_COMPANY_NAME,
  companyDomain: STIFTUNG_KIND_AUTISMUS_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Urdorf',
  defaultPostalCode: '8902',
  publicCareerUrl: 'https://www.kind-autismus.ch/jobs/',
  defaultSourceLang: 'de',
  listingHost: 'app.reflinejobs.io',
  // Foundation is sociale / educazione — not a hospital, despite healthcare
  // adjacency for the autism-specialist staff.
  sector: 'Sociale / Educazione',
  sourceLabel: 'Stiftung Kind und Autismus Dedicated Parser (Refline 2044)',
});

export const fetchAllStiftungKindAutismusJobs = parser.fetchAllJobs;
export const isStiftungKindAutismusJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
