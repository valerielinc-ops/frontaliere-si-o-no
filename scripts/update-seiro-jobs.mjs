#!/usr/bin/env node
/**
 * Dedicated SEIRO GmbH crawler runner.
 *
 * Uses the standard crawler template with the SEIRO GmbH parser.
 * All fetch/parse logic lives in ./lib/seiro-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSeiroJobs,
  isSeiroJob,
  isTrustedDomain,
  SEIRO_KEY,
  SEIRO_COMPANY_NAME,
} from './lib/seiro-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SEIRO_KEY,
  companyLabel: SEIRO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSeiroJobs,
  isCompanyJob: isSeiroJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SEIRO GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
