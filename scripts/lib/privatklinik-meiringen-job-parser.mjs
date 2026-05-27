#!/usr/bin/env node
/**
 * Privatklinik Meiringen — Jobalino tenant (Michel Gruppe AG).
 *
 * Privatklinik Meiringen is a psychiatric private hospital in Meiringen (BE),
 * member of the Michel Gruppe AG. Public career site:
 *   https://privatklinik-meiringen.ch/karriere/
 *
 * The corporate page embeds the `<jobalino-joblist>` web component:
 *   <jobalino-joblist
 *     company="privatklinik-meiringen"
 *     additional_companies="michel-gruppe-ag"
 *     filter5="Ja">
 *
 * Our parser uses the same JSONP endpoint
 *   https://my.jobalino.ch/custel_jobExternalList/privatklinik-meiringen
 *   ?additional_company_names=michel-gruppe-ag&filter5=Ja
 *
 * Detail pages are at https://my.jobalino.ch/job/{HASH}/{slug} and ship
 * a clean schema.org JobPosting JSON-LD payload — see
 * `scripts/lib/jobalino-common.mjs` for the shared factory.
 *
 * Note: Klinik Aadorf (the sibling clinic in TG) does NOT have a standalone
 * Jobalino tenant. Aadorf openings flow through the `michel-gruppe-ag`
 * umbrella tenant (see michel-gruppe-job-parser.mjs).
 */
import { createJobalinoParser } from './jobalino-common.mjs';

export const PRIVATKLINIK_MEIRINGEN_KEY = 'privatklinik-meiringen';
export const PRIVATKLINIK_MEIRINGEN_COMPANY_NAME = 'Privatklinik Meiringen';
export const PRIVATKLINIK_MEIRINGEN_COMPANY_DOMAIN = 'privatklinik-meiringen.ch';

const parser = createJobalinoParser({
  jobalinoCompanySlug: 'privatklinik-meiringen',
  // Mirror the production widget config — pulls Meiringen-specific openings
  // out of the Michel-Gruppe AG umbrella plus any Aadorf jobs Michel-Gruppe
  // posts on behalf of the privatklinik network.
  additionalCompanies: 'michel-gruppe-ag',
  listingFilters: { filter5: 'Ja' },
  locale: 'de',
  companyKey: PRIVATKLINIK_MEIRINGEN_KEY,
  companyName: PRIVATKLINIK_MEIRINGEN_COMPANY_NAME,
  companyDomain: PRIVATKLINIK_MEIRINGEN_COMPANY_DOMAIN,
  publicCareerUrl: 'https://privatklinik-meiringen.ch/karriere/',
  defaultCanton: 'BE',
  defaultCity: 'Meiringen',
  defaultPostalCode: '3860',
  defaultSourceLang: 'de',
  sourceLabel: 'Privatklinik Meiringen Dedicated Parser (Jobalino)',
  // Keep only tiles whose company span matches "Meiringen" — guarantees we
  // don't accidentally claim Michel-Gruppe AG corporate-HQ openings that
  // belong to a sibling clinic.
  matchCompanyName: 'Meiringen',
});

export const fetchAllPrivatklinikMeiringenJobs = parser.fetchAllJobs;
export const isPrivatklinikMeiringenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
