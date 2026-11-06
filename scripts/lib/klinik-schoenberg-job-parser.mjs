#!/usr/bin/env node
/**
 * Klinik Schönberg (Gunten am Thunersee, BE) — Jobalino tenant.
 *
 * Private rehabilitation clinic on lake Thun. Career landing page at
 *
 *   https://www.klinik-schoenberg.ch/karriere/offene-stellen
 *
 * embeds a `my.jobalino.ch` widget for `klinik-schoenberg-ag`. The
 * standalone endpoint
 *
 *   https://my.jobalino.ch/custel_jobExternalList/klinik-schoenberg-ag
 *
 * returns the JSONP envelope but at the time of writing carries only
 * Spontanbewerbung links (no live `<a class="reflink" href="…/job/…">`
 * tiles). The parser still ships so the crawler is ready the moment a
 * real vacancy is published — `createJobalinoParser` returns an empty
 * array when no reflinks are present, which the standard pipeline
 * treats as "0 jobs" without failing.
 *
 * Build with `matchCompanyName` set so any sibling jobs that might leak
 * through the API stay filtered out.
 */
import { createJobalinoParser } from './jobalino-common.mjs';

export const KLINIK_SCHOENBERG_KEY = 'klinik-schoenberg';
export const KLINIK_SCHOENBERG_COMPANY_NAME = 'Klinik Schönberg AG';
export const KLINIK_SCHOENBERG_COMPANY_DOMAIN = 'klinik-schoenberg.ch';

const parser = createJobalinoParser({
  jobalinoCompanySlug: 'klinik-schoenberg-ag',
  companyKey: KLINIK_SCHOENBERG_KEY,
  companyName: KLINIK_SCHOENBERG_COMPANY_NAME,
  companyDomain: KLINIK_SCHOENBERG_COMPANY_DOMAIN,
  defaultCanton: 'BE',
  defaultCity: 'Gunten',
  defaultPostalCode: '3654',
  publicCareerUrl: 'https://www.klinik-schoenberg.ch/karriere/offene-stellen',
  defaultSourceLang: 'de',
  sourceLabel: 'Klinik Schönberg Dedicated Parser (Jobalino)',
  matchCompanyName: 'Schönberg',
});

export const fetchAllKlinikSchoenbergJobs = parser.fetchAllJobs;
export const isKlinikSchoenbergJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
