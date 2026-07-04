#!/usr/bin/env node
/**
 * Dedicated Valiant Bank AG crawler runner.
 *
 * Uses the standard crawler template with the Valiant Bank parser.
 * All fetch/parse logic lives in ./lib/valiant-bank-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllValiantBankJobs,
  isValiantBankJob,
  isTrustedDomain,
  VALIANT_BANK_KEY,
  VALIANT_BANK_COMPANY_NAME,
} from './lib/valiant-bank-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VALIANT_BANK_KEY,
  companyLabel: VALIANT_BANK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllValiantBankJobs,
  isCompanyJob: isValiantBankJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Valiant Bank AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
