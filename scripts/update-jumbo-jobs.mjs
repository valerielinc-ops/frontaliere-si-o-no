#!/usr/bin/env node
/**
 * Dedicated JUMBO crawler runner.
 *
 * Uses the standard crawler template with the JUMBO parser.
 * All fetch/parse logic lives in ./lib/jumbo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { enrichCoopSourceBackedJobs } from './lib/coop-job-parser.mjs';
import {
  fetchAllJumboJobs,
  isJumboJob,
  isTrustedDomain,
  JUMBO_KEY,
  JUMBO_COMPANY_NAME,
} from './lib/jumbo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JUMBO_KEY,
  companyLabel: JUMBO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: async () => enrichCoopSourceBackedJobs(await fetchAllJumboJobs(), {
    allowedHosts: ['jobs.coopjobs.ch'],
  }),
  isCompanyJob: isJumboJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
}).catch((err) => {
  console.error(`❌ JUMBO crawler failed: ${err?.message || err}`);
  process.exit(1);
});
