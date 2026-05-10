#!/usr/bin/env node
/**
 * Dedicated Zurich Insurance Group crawler runner.
 *
 * Uses the standard crawler template with the Zurich Insurance Group parser.
 * All fetch/parse logic lives in ./lib/zurich-insurance-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZurichInsuranceJobs,
  isZurichInsuranceJob,
  isTrustedDomain,
  ZURICH_INSURANCE_KEY,
  ZURICH_INSURANCE_COMPANY_NAME,
} from './lib/zurich-insurance-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZURICH_INSURANCE_KEY,
  companyLabel: ZURICH_INSURANCE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZurichInsuranceJobs,
  isCompanyJob: isZurichInsuranceJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Zurich Insurance Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
