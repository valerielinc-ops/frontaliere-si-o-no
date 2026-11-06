#!/usr/bin/env node
/**
 * Dedicated Jobdoor AG crawler runner.
 *
 * Uses the standard crawler template with the Jobdoor AG parser.
 * All fetch/parse logic lives in ./lib/jobdoor-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllJobdoorChJobs,
  isJobdoorChJob,
  isTrustedDomain,
  JOBDOOR_CH_KEY,
  JOBDOOR_CH_COMPANY_NAME,
} from './lib/jobdoor-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JOBDOOR_CH_KEY,
  companyLabel: JOBDOOR_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllJobdoorChJobs,
  isCompanyJob: isJobdoorChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Jobdoor AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
