#!/usr/bin/env node
/**
 * Rehaklinik Hasliberg — Jobalino tenant (Michel Gruppe AG sibling).
 *
 * Rehaklinik Hasliberg is a rehabilitation clinic at Hasliberg Hohfluh (BE,
 * 6083) operated by the Michel Gruppe AG (sibling of Privatklinik Meiringen).
 * Public career page:
 *   https://rehaklinik-hasliberg.ch/offene-stellen/
 *
 * The page embeds a `<jobalino-joblist>` widget pointing at the Jobalino
 * tenant `rehaklinik-hasliberg`. The endpoint
 *
 *   https://my.jobalino.ch/custel_jobExternalList/rehaklinik-hasliberg
 *
 * returns the standard `jb_ShowJsonHtml({...})` JSONP envelope with one
 * `<a class="reflink">` per opening. Detail pages
 *
 *   https://my.jobalino.ch/job/{HASH}/{slug}
 *
 * carry a schema.org JobPosting `application/ld+json` block — handled by
 * the shared factory in scripts/lib/jobalino-common.mjs.
 *
 * Probe 2026-05-20: 8 openings (admin, Pflege, Medizin, Therapien),
 * including ZSSM Bern positions cross-posted via the same tenant. We
 * keep them — they're still part of the Rehaklinik Hasliberg payroll.
 *
 * Re-discovery note: previously listed under DNS-dead candidates because
 * the original domain probe used `hasliberg.ch` (housing co-op,
 * unrelated). The actual hospital lives at `rehaklinik-hasliberg.ch`.
 */
import { createJobalinoParser } from './jobalino-common.mjs';

export const REHAKLINIK_HASLIBERG_KEY = 'rehaklinik-hasliberg';
export const REHAKLINIK_HASLIBERG_COMPANY_NAME = 'Rehaklinik Hasliberg';
export const REHAKLINIK_HASLIBERG_COMPANY_DOMAIN = 'rehaklinik-hasliberg.ch';

const parser = createJobalinoParser({
  jobalinoCompanySlug: 'rehaklinik-hasliberg',
  locale: 'de',
  companyKey: REHAKLINIK_HASLIBERG_KEY,
  companyName: REHAKLINIK_HASLIBERG_COMPANY_NAME,
  companyDomain: REHAKLINIK_HASLIBERG_COMPANY_DOMAIN,
  publicCareerUrl: 'https://rehaklinik-hasliberg.ch/offene-stellen/',
  defaultCanton: 'BE',
  defaultCity: 'Hasliberg Hohfluh',
  defaultPostalCode: '6083',
  defaultSourceLang: 'de',
  sourceLabel: 'Rehaklinik Hasliberg Dedicated Parser (Jobalino)',
});

export const fetchAllRehaklinikHaslibergJobs = parser.fetchAllJobs;
export const isRehaklinikHaslibergJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
