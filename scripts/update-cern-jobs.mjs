#!/usr/bin/env node
/**
 * Dedicated CERN crawler runner.
 *
 * Uses the standard crawler template with the CERN parser.
 * All fetch/parse logic lives in ./lib/cern-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCernJobs,
  isCernJob,
  isTrustedDomain,
  CERN_KEY,
  CERN_COMPANY_NAME,
} from './lib/cern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CERN_KEY,
  companyLabel: CERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCernJobs,
  isCompanyJob: isCernJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ CERN crawler failed: ${err?.message || err}`);
  process.exit(1);
});
