#!/usr/bin/env node
/**
 * Dedicated dormakaba crawler runner.
 *
 * Uses the standard crawler template with the dormakaba parser.
 * All fetch/parse logic lives in ./lib/dormakaba-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDormakabaJobs,
  isDormakabaJob,
  isTrustedDomain,
  DORMAKABA_KEY,
  DORMAKABA_COMPANY_NAME,
} from './lib/dormakaba-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DORMAKABA_KEY,
  companyLabel: DORMAKABA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDormakabaJobs,
  isCompanyJob: isDormakabaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  matchKey: (job) => String(job?.slug || '').trim().toLowerCase(),
}).catch((err) => {
  console.error(`❌ dormakaba crawler failed: ${err?.message || err}`);
  process.exit(1);
});
