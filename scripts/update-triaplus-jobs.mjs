#!/usr/bin/env node
/**
 * Dedicated Triaplus crawler runner.
 *
 * Uses the standard crawler template with the Triaplus parser
 * (custom WordPress career site at karriere.triaplus.ch — multi-clinic
 * psychiatric group in ZG with paginated listing).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTriaplusJobs,
  isTriaplusJob,
  isTrustedDomain,
  TRIAPLUS_KEY,
  TRIAPLUS_COMPANY_NAME,
} from './lib/triaplus-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TRIAPLUS_KEY,
  companyLabel: TRIAPLUS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTriaplusJobs,
  isCompanyJob: isTriaplusJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Triaplus crawler failed: ${err?.message || err}`);
  process.exit(1);
});
