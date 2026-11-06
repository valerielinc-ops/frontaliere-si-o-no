#!/usr/bin/env node
/**
 * Dedicated Apple Retail Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Apple Retail Switzerland parser.
 * All fetch/parse logic lives in ./lib/apple-retail-switzerland-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAppleRetailSwitzerlandJobs,
  isAppleRetailSwitzerlandJob,
  isTrustedDomain,
  APPLE_RETAIL_SWITZERLAND_KEY,
  APPLE_RETAIL_SWITZERLAND_COMPANY_NAME,
} from './lib/apple-retail-switzerland-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: APPLE_RETAIL_SWITZERLAND_KEY,
  companyLabel: APPLE_RETAIL_SWITZERLAND_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAppleRetailSwitzerlandJobs,
  isCompanyJob: isAppleRetailSwitzerlandJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Apple Retail Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
