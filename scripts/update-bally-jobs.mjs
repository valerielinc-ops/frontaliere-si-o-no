#!/usr/bin/env node
/**
 * Dedicated Bally crawler runner.
 *
 * Uses the standard crawler template with the Bally parser.
 * All fetch/parse logic lives in ./lib/bally-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBallyJobs,
  isBallyJob,
  isTrustedDomain,
  BALLY_KEY,
  BALLY_COMPANY_NAME,
} from './lib/bally-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BALLY_KEY,
  companyLabel: BALLY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBallyJobs,
  isCompanyJob: isBallyJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bally crawler failed: ${err?.message || err}`);
  process.exit(1);
});
