#!/usr/bin/env node
/**
 * Dedicated OK Job SA, succursale di Mendrisio crawler runner.
 *
 * Uses the standard crawler template with the OK Job SA, succursale di Mendrisio parser.
 * All fetch/parse logic lives in ./lib/okjob-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOkjobJobs,
  isOkjobJob,
  isTrustedDomain,
  OKJOB_KEY,
  OKJOB_COMPANY_NAME,
} from './lib/okjob-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OKJOB_KEY,
  companyLabel: OKJOB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOkjobJobs,
  isCompanyJob: isOkjobJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ OK Job SA, succursale di Mendrisio crawler failed: ${err?.message || err}`);
  process.exit(1);
});
