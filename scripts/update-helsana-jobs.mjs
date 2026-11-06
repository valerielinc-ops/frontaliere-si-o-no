#!/usr/bin/env node
/**
 * Dedicated Helsana crawler runner.
 *
 * Uses the standard crawler template with the Helsana parser.
 * All fetch/parse logic lives in ./lib/helsana-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHelsanaJobs,
  isHelsanaJob,
  isTrustedDomain,
  HELSANA_KEY,
  HELSANA_COMPANY_NAME,
} from './lib/helsana-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HELSANA_KEY,
  companyLabel: HELSANA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHelsanaJobs,
  isCompanyJob: isHelsanaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Helsana crawler failed: ${err?.message || err}`);
  process.exit(1);
});
