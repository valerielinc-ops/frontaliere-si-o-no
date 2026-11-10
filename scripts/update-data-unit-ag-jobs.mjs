#!/usr/bin/env node
/**
 * Dedicated DATA UNIT AG crawler runner.
 *
 * Uses the standard crawler template with the DATA UNIT AG parser.
 * All fetch/parse logic lives in ./lib/data-unit-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDataUnitAgJobs,
  isDataUnitAgJob,
  isTrustedDomain,
  DATA_UNIT_AG_KEY,
  DATA_UNIT_AG_COMPANY_NAME,
} from './lib/data-unit-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DATA_UNIT_AG_KEY,
  companyLabel: DATA_UNIT_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDataUnitAgJobs,
  isCompanyJob: isDataUnitAgJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ DATA UNIT AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
