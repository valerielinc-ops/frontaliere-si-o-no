#!/usr/bin/env node
/**
 * Dedicated BKW crawler runner.
 *
 * Uses the standard crawler template with the BKW parser.
 * All fetch/parse logic lives in ./lib/bkw-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBkwJobs,
  isBkwJob,
  isTrustedDomain,
  BKW_KEY,
  BKW_COMPANY_NAME,
} from './lib/bkw-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BKW_KEY,
  companyLabel: BKW_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBkwJobs,
  isCompanyJob: isBkwJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ BKW crawler failed: ${err?.message || err}`);
  process.exit(1);
});
