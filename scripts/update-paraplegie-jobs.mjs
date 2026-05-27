#!/usr/bin/env node
/**
 * Dedicated Schweizer Paraplegiker-Gruppe (Nottwil) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllParaplegieJobs,
  isParaplegieJob,
  isTrustedDomain,
  PARAPLEGIE_KEY,
  PARAPLEGIE_COMPANY_NAME,
} from './lib/paraplegie-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PARAPLEGIE_KEY,
  companyLabel: PARAPLEGIE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllParaplegieJobs,
  isCompanyJob: isParaplegieJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Schweizer Paraplegiker-Gruppe crawler failed: ${err?.message || err}`);
  process.exit(1);
});
