#!/usr/bin/env node
/**
 * Dedicated elvetino crawler runner.
 *
 * Uses the standard crawler template with the elvetino parser.
 * All fetch/parse logic lives in ./lib/company-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCompanyJobs,
  isCompanyJob,
  isTrustedDomain,
  COMPANY_KEY,
  COMPANY_COMPANY_NAME,
} from './lib/company-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: COMPANY_KEY,
  companyLabel: COMPANY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCompanyJobs,
  isCompanyJob: isCompanyJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ elvetino crawler failed: ${err?.message || err}`);
  process.exit(1);
});
