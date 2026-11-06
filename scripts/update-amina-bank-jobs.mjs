#!/usr/bin/env node
/**
 * Dedicated AMINA Bank crawler runner.
 *
 * Uses the standard crawler template with the AMINA Bank parser.
 * All fetch/parse logic lives in ./lib/amina-bank-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAminaBankJobs,
  isAminaBankJob,
  isTrustedDomain,
  AMINA_BANK_KEY,
  AMINA_BANK_COMPANY_NAME,
} from './lib/amina-bank-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AMINA_BANK_KEY,
  companyLabel: AMINA_BANK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAminaBankJobs,
  isCompanyJob: isAminaBankJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ AMINA Bank crawler failed: ${err?.message || err}`);
  process.exit(1);
});
