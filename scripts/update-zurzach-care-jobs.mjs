#!/usr/bin/env node
/**
 * Dedicated ZURZACH Care crawler runner.
 *
 * Uses the standard crawler template with the ZURZACH Care parser.
 * All fetch/parse logic lives in ./lib/zurzach-care-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZurzachCareJobs,
  isZurzachCareJob,
  isTrustedDomain,
  ZURZACH_CARE_KEY,
  ZURZACH_CARE_COMPANY_NAME,
} from './lib/zurzach-care-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZURZACH_CARE_KEY,
  companyLabel: ZURZACH_CARE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZurzachCareJobs,
  isCompanyJob: isZurzachCareJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ZURZACH Care crawler failed: ${err?.message || err}`);
  process.exit(1);
});
