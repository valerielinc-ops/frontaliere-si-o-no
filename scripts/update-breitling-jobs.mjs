#!/usr/bin/env node
/**
 * Dedicated Breitling crawler runner.
 *
 * Uses the standard crawler template with the Breitling parser.
 * All fetch/parse logic lives in ./lib/breitling-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBreitlingJobs,
  isBreitlingJob,
  isTrustedDomain,
  BREITLING_KEY,
  BREITLING_COMPANY_NAME,
} from './lib/breitling-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BREITLING_KEY,
  companyLabel: BREITLING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBreitlingJobs,
  isCompanyJob: isBreitlingJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Breitling crawler failed: ${err?.message || err}`);
  process.exit(1);
});
