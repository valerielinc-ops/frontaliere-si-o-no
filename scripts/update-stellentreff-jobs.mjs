#!/usr/bin/env node
/**
 * Dedicated Stellentreff AG crawler runner.
 *
 * Uses the standard crawler template with the Stellentreff AG parser.
 * All fetch/parse logic lives in ./lib/stellentreff-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStellentreffJobs,
  isStellentreffJob,
  isTrustedDomain,
  STELLENTREFF_KEY,
  STELLENTREFF_COMPANY_NAME,
} from './lib/stellentreff-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STELLENTREFF_KEY,
  companyLabel: STELLENTREFF_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStellentreffJobs,
  isCompanyJob: isStellentreffJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stellentreff AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
