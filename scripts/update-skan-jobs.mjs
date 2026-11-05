#!/usr/bin/env node
/**
 * Dedicated Skan AG crawler runner.
 *
 * Uses the standard crawler template with the Skan AG parser.
 * All fetch/parse logic lives in ./lib/skan-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSkanJobs,
  isSkanJob,
  isTrustedDomain,
  SKAN_KEY,
  SKAN_COMPANY_NAME,
} from './lib/skan-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SKAN_KEY,
  companyLabel: SKAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSkanJobs,
  isCompanyJob: isSkanJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Skan AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
