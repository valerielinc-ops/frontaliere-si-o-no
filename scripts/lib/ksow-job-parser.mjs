#!/usr/bin/env node
/**
 * Kantonsspital Obwalden (KSOW) job parser — Ostendis OJP widget.
 *
 * Public career site: https://www.ksow.ch/jobs-karriere/offene-stellen
 *   The page embeds the Ostendis Jobs Platform widget via
 *   `OSTENDISJOBS.embed('f564e9db84644054a62ed5135980a4aa','DE','#ostendisJobs',{})`.
 *   The widget hydrates a `<div id="ostendisJobs">` with `<a href="link.ostendis.com/publication/{slug}/{token}">` anchors after the loader runs — about ~14 active openings.
 *
 * Detail pages live on `link.ostendis.com/publication/...` and ship a
 * JSON-LD `JobPosting` block that the shared factory parses.
 *
 * KSOW is the cantonal acute hospital in Sarnen (OW), ~600 employees,
 * single campus. Founding member of the LUKS group network but operates an
 * independent ATS (separate from Prospective tenant 1003280 used by LUKS).
 */
import { createOstendisPublicationParser } from './ostendis-publication-common.mjs';

export const KSOW_KEY = 'ksow';
export const KSOW_COMPANY_NAME = 'Kantonsspital Obwalden';
export const KSOW_COMPANY_DOMAIN = 'ksow.ch';

const parser = createOstendisPublicationParser({
  companyKey: KSOW_KEY,
  companyName: KSOW_COMPANY_NAME,
  companyDomain: KSOW_COMPANY_DOMAIN,
  careerUrl: 'https://www.ksow.ch/jobs-karriere/offene-stellen',
  defaultCanton: 'OW',
  defaultCity: 'Sarnen',
  defaultPostalCode: '6060',
  defaultSourceLang: 'de',
  sector: 'Sanità / Ospedali',
});

export const fetchAllKsowJobs = parser.fetchAllJobs;
export const isKsowJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
