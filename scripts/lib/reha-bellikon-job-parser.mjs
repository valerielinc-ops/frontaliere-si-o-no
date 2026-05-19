#!/usr/bin/env node
/**
 * Rehaklinik Bellikon (Reha Bellikon AG) — JobPublish.ch tenant.
 *
 * Reha Bellikon is a Suva-operated rehabilitation clinic in Bellikon (AG),
 * specialising in trauma, neurological and musculoskeletal rehabilitation
 * after accidents. ~700 collaborators on the Reusstal campus. Public
 * career site:
 *   https://jobs.rehabellikon.ch/  (JobPublish-rendered)
 *   https://www.rehabellikon.ch/karriere  (corporate, redirects to jobs.*)
 *
 * Tenant slug `rkb` (revealed by the JobPublish JS asset
 * `static.jobpublish.ch/clients/rkb/joblist-XXXX.js` embedded on the jobs
 * subdomain). The public XML feed lives at
 *   https://jobs.jobpublish.ch/feed/v2/website/rkb
 *
 * Detail pages are hosted on the tenant's `job.rehabellikon.ch` mirror
 * (different from the `jobs.*` listing host) — captured by
 * `extraTrustedHosts` so URL gates accept them.
 *
 * See `scripts/lib/jobpublish-ch-common.mjs` for the shared factory.
 */
import { createJobpublishChParser } from './jobpublish-ch-common.mjs';

export const REHA_BELLIKON_KEY = 'reha-bellikon';
export const REHA_BELLIKON_COMPANY_NAME = 'Rehaklinik Bellikon';
export const REHA_BELLIKON_COMPANY_DOMAIN = 'rehabellikon.ch';

const parser = createJobpublishChParser({
  jobpublishTenant: 'rkb',
  companyKey: REHA_BELLIKON_KEY,
  companyName: REHA_BELLIKON_COMPANY_NAME,
  companyDomain: REHA_BELLIKON_COMPANY_DOMAIN,
  publicCareerUrl: 'https://jobs.rehabellikon.ch/',
  defaultCanton: 'AG',
  defaultCity: 'Bellikon',
  defaultPostalCode: '5454',
  defaultSourceLang: 'de',
  sourceLabel: 'Rehaklinik Bellikon Dedicated Parser (JobPublish.ch)',
  extraTrustedHosts: ['jobs.rehabellikon.ch', 'job.rehabellikon.ch'],
});

export const fetchAllRehaBellikonJobs = parser.fetchAllJobs;
export const isRehaBellikonJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
