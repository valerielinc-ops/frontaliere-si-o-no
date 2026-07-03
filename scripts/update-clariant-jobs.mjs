#!/usr/bin/env node
/**
 * Dedicated Clariant crawler runner.
 *
 * Uses the standard crawler template with the Clariant parser.
 * All fetch/parse logic lives in ./lib/clariant-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClariantJobs,
  isClariantJob,
  isTrustedDomain,
  CLARIANT_KEY,
  CLARIANT_COMPANY_NAME,
} from './lib/clariant-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLARIANT_KEY,
  companyLabel: CLARIANT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClariantJobs,
  isCompanyJob: isClariantJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Clariant crawler failed: ${err?.message || err}`);
  process.exit(1);
});
