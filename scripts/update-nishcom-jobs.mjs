#!/usr/bin/env node
/**
 * Dedicated nishcom crawler runner.
 *
 * Uses the standard crawler template with the nishcom parser.
 * All fetch/parse logic lives in ./lib/nishcom-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNishcomJobs,
  isNishcomJob,
  isTrustedDomain,
  NISHCOM_KEY,
  NISHCOM_COMPANY_NAME,
} from './lib/nishcom-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NISHCOM_KEY,
  companyLabel: NISHCOM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNishcomJobs,
  isCompanyJob: isNishcomJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ nishcom crawler failed: ${err?.message || err}`);
  process.exit(1);
});
