#!/usr/bin/env node
/**
 * Dedicated Interdiscount crawler runner.
 *
 * Uses the standard crawler template with the Interdiscount parser.
 * All fetch/parse logic lives in ./lib/interdiscount-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllInterdiscountJobs,
  isInterdiscountJob,
  isTrustedDomain,
  INTERDISCOUNT_KEY,
  INTERDISCOUNT_COMPANY_NAME,
} from './lib/interdiscount-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INTERDISCOUNT_KEY,
  companyLabel: INTERDISCOUNT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllInterdiscountJobs,
  isCompanyJob: isInterdiscountJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Interdiscount crawler failed: ${err?.message || err}`);
  process.exit(1);
});
