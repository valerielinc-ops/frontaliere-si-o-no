#!/usr/bin/env node
/**
 * Dedicated Tecan crawler runner.
 *
 * Uses the standard crawler template with the Tecan parser.
 * All fetch/parse logic lives in ./lib/tecan-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTecanJobs,
  isTecanJob,
  isTrustedDomain,
  TECAN_KEY,
  TECAN_COMPANY_NAME,
} from './lib/tecan-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TECAN_KEY,
  companyLabel: TECAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTecanJobs,
  isCompanyJob: isTecanJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Tecan crawler failed: ${err?.message || err}`);
  process.exit(1);
});
