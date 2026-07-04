#!/usr/bin/env node
/**
 * Dedicated Swisslog crawler runner.
 *
 * Uses the standard crawler template with the Swisslog parser.
 * All fetch/parse logic lives in ./lib/swisslog-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwisslogJobs,
  isSwisslogJob,
  isTrustedDomain,
  SWISSLOG_KEY,
  SWISSLOG_COMPANY_NAME,
} from './lib/swisslog-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWISSLOG_KEY,
  companyLabel: SWISSLOG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwisslogJobs,
  isCompanyJob: isSwisslogJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Swisslog crawler failed: ${err?.message || err}`);
  process.exit(1);
});
