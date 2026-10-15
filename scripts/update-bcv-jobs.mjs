#!/usr/bin/env node
/**
 * Dedicated Banque Cantonale Vaudoise crawler runner.
 *
 * Uses the standard crawler template with the Banque Cantonale Vaudoise parser.
 * All fetch/parse logic lives in ./lib/bcv-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBcvJobs,
  isBcvJob,
  isTrustedDomain,
  BCV_KEY,
  BCV_COMPANY_NAME,
} from './lib/bcv-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BCV_KEY,
  companyLabel: BCV_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBcvJobs,
  isCompanyJob: isBcvJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Banque Cantonale Vaudoise crawler failed: ${err?.message || err}`);
  process.exit(1);
});
