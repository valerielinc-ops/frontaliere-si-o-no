#!/usr/bin/env node
/**
 * Dedicated Google Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Google Switzerland parser.
 * All fetch/parse logic lives in ./lib/google-switzerland-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGoogleSwitzerlandJobs,
  isGoogleSwitzerlandJob,
  isTrustedDomain,
  GOOGLE_SWITZERLAND_KEY,
  GOOGLE_SWITZERLAND_COMPANY_NAME,
} from './lib/google-switzerland-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GOOGLE_SWITZERLAND_KEY,
  companyLabel: GOOGLE_SWITZERLAND_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGoogleSwitzerlandJobs,
  isCompanyJob: isGoogleSwitzerlandJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Google Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
