#!/usr/bin/env node
/**
 * Dedicated Tether Operations crawler runner.
 *
 * Uses the standard crawler template with the Tether Operations parser.
 * All fetch/parse logic lives in ./lib/tether-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTetherJobs,
  isTetherJob,
  isTrustedDomain,
  TETHER_KEY,
  TETHER_COMPANY_NAME,
} from './lib/tether-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TETHER_KEY,
  companyLabel: TETHER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTetherJobs,
  isCompanyJob: isTetherJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Tether Operations crawler failed: ${err?.message || err}`);
  process.exit(1);
});
