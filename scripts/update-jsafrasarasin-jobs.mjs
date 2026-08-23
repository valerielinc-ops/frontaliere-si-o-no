#!/usr/bin/env node
/**
 * Dedicated J. Safra Sarasin crawler runner.
 *
 * Uses the standard crawler template with the J. Safra Sarasin parser.
 * All fetch/parse logic lives in ./lib/jsafrasarasin-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllJsafrasarasinJobs,
  isJsafrasarasinJob,
  isTrustedDomain,
  JSAFRASARASIN_KEY,
  JSAFRASARASIN_COMPANY_NAME,
} from './lib/jsafrasarasin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JSAFRASARASIN_KEY,
  companyLabel: JSAFRASARASIN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllJsafrasarasinJobs,
  isCompanyJob: isJsafrasarasinJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ J. Safra Sarasin crawler failed: ${err?.message || err}`);
  process.exit(1);
});
