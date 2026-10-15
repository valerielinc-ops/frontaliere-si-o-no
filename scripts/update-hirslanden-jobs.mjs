#!/usr/bin/env node
/**
 * Dedicated Hirslanden Klinik crawler runner.
 *
 * Uses the standard crawler template with the Hirslanden Klinik parser.
 * All fetch/parse logic lives in ./lib/hirslanden-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHirslandenJobs,
  isHirslandenJob,
  isTrustedDomain,
  HIRSLANDEN_KEY,
  HIRSLANDEN_COMPANY_NAME,
} from './lib/hirslanden-job-parser.mjs';
import { dropStaleLocaleDescriptions, resyncStoredSourceLang } from './lib/source-locale-slots.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HIRSLANDEN_KEY,
  companyLabel: HIRSLANDEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHirslandenJobs,
  isCompanyJob: isHirslandenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
  // Stored French postings were filed under a fixed `de`: move each body to
  // its own language before the merge, which would keep it under `de`, and
  // hand the slots not in their own language back to the translation pipeline.
  prepareExistingJobs: (jobs) => {
    for (const job of jobs) {
      resyncStoredSourceLang(job);
      dropStaleLocaleDescriptions(job);
    }
    return jobs;
  },
}).catch((err) => {
  console.error(`❌ Hirslanden Klinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
