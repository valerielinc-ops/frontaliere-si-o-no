#!/usr/bin/env node
/**
 * Dedicated Union Bancaire Privée crawler runner.
 *
 * Uses the standard crawler template with the Union Bancaire Privée parser.
 * All fetch/parse logic lives in ./lib/ubp-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUbpJobs,
  isUbpJob,
  isTrustedDomain,
  UBP_KEY,
  UBP_COMPANY_NAME,
} from './lib/ubp-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UBP_KEY,
  companyLabel: UBP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUbpJobs,
  isCompanyJob: isUbpJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Union Bancaire Privée crawler failed: ${err?.message || err}`);
  process.exit(1);
});
