#!/usr/bin/env node
/**
 * Dedicated localsearch crawler runner.
 *
 * Uses the standard crawler template with the localsearch parser.
 * All fetch/parse logic lives in ./lib/localsearch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLocalsearchJobs,
  isLocalsearchJob,
  isTrustedDomain,
  LOCALSEARCH_KEY,
  LOCALSEARCH_COMPANY_NAME,
} from './lib/localsearch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LOCALSEARCH_KEY,
  companyLabel: LOCALSEARCH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLocalsearchJobs,
  isCompanyJob: isLocalsearchJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ localsearch crawler failed: ${err?.message || err}`);
  process.exit(1);
});
