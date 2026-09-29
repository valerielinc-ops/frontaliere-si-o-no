#!/usr/bin/env node
/**
 * Dedicated UPD / UPZ Bern crawler runner (Prospective.ch medium 1000842; the
 * former Umantis tenant 2908 redirects every vacancy away — see
 * lib/upd-job-parser.mjs).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUpdJobs,
  isUpdJob,
  isTrustedDomain,
  bridgeUmantisUpdJobs,
  UPD_KEY,
  UPD_COMPANY_NAME,
} from './lib/upd-job-parser.mjs';
import { repairStoredUmantisJobs } from './lib/umantis-listing-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// The stored jobs are matched to this run's jobs before the merge, so the
// fetch result is kept for `prepareExistingJobs`.
let freshJobs = [];

runStandardCrawlerPipeline({
  companyKey: UPD_KEY,
  companyLabel: UPD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: async () => {
    freshJobs = await fetchAllUpdJobs();
    return freshJobs;
  },
  isCompanyJob: isUpdJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => {
    // Text the Umantis factory wrote into the stored jobs goes first; then
    // the jobs of the old tenant that the new source still publishes are
    // pointed at their Prospective URL, so the merge keeps their pages.
    repairStoredUmantisJobs(jobs, UPD_COMPANY_NAME);
    const bridged = bridgeUmantisUpdJobs(jobs, freshJobs);
    if (bridged > 0) console.log(`  🔗 ${UPD_COMPANY_NAME}: ${bridged} stored Umantis job(s) matched to their Prospective vacancy`);
    return jobs;
  },
}).catch((err) => {
  console.error(`❌ UPD crawler failed: ${err?.message || err}`);
  process.exit(1);
});
