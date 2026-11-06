#!/usr/bin/env node
/**
 * Dedicated CreditX Sàrl crawler runner.
 *
 * Uses the standard crawler template with the CreditX Sàrl parser.
 * All fetch/parse logic lives in ./lib/creditx-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCreditxChJobs,
  isCreditxChJob,
  isTrustedDomain,
  CREDITX_CH_KEY,
  CREDITX_CH_COMPANY_NAME,
} from './lib/creditx-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CREDITX_CH_KEY,
  companyLabel: CREDITX_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCreditxChJobs,
  isCompanyJob: isCreditxChJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ CreditX Sàrl crawler failed: ${err?.message || err}`);
  process.exit(1);
});
