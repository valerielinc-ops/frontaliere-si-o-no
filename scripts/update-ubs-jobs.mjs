#!/usr/bin/env node
/**
 * Dedicated UBS crawler runner.
 *
 * Uses the standard crawler template with the UBS parser.
 * All fetch/parse logic lives in ./lib/ubs-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUbsJobs,
  isUbsJob,
  isTrustedDomain,
  UBS_KEY,
  UBS_COMPANY_NAME,
} from './lib/ubs-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UBS_KEY,
  companyLabel: UBS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUbsJobs,
  isCompanyJob: isUbsJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ UBS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
