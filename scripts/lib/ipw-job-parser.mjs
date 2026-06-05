#!/usr/bin/env node
/**
 * ipw — Integrierte Psychiatrie Winterthur job parser — Solique board (API variant).
 *
 * Live source:   https://live.solique.ch/ipw/de/  (Solique AngularJS board)
 *   - job list:   https://live.solique.ch/ipw/de/api/v1/data/   (JSON)
 *   - job detail: https://live.solique.ch/ipw/de/jobs/{slug}--{id}  (SSR HTML)
 * Public career: https://www.ipw.ch/karriere (embeds the Solique board)
 *
 * Migrated off Umantis: the old tenant 2906 listing's `/Vacancies/{id}/Description`
 * page now 302-redirects to the public site (issue #1245) and was additionally
 * Cloudflare-walled to datacenter IPs; the Solique board is the live source of
 * truth with full server-rendered descriptions. Crawled via the shared
 * `createSoliqueParser` in `mode: 'api'` (JSON list endpoint + SSR detail pages).
 *
 * Psychiatric services for the region Winterthur–Zürcher Unterland (ZH).
 */
import { createSoliqueParser } from './solique-common.mjs';

export const IPW_KEY = 'ipw';
export const IPW_COMPANY_NAME = 'Integrierte Psychiatrie Winterthur (ipw)';
export const IPW_COMPANY_DOMAIN = 'ipw.ch';

const parser = createSoliqueParser({
  soliqueTenant: 'ipw',
  mode: 'api',
  migratedBoard: true,
  apiLang: 'de',
  companyKey: IPW_KEY,
  companyName: IPW_COMPANY_NAME,
  companyDomain: IPW_COMPANY_DOMAIN,
  defaultCanton: 'ZH',
  defaultCity: 'Winterthur',
  defaultPostalCode: '8408',
  defaultSourceLang: 'de',
});

export const fetchAllIpwJobs = parser.fetchAllJobs;
export const isIpwJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
