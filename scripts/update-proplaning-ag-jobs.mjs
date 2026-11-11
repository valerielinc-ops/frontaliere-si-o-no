#!/usr/bin/env node
/**
 * Dedicated Proplaning AG crawler runner.
 *
 * Uses the standard crawler template with the Proplaning AG parser.
 * All fetch/parse logic lives in ./lib/proplaning-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllProplaningAgJobs,
  isProplaningAgJob,
  isTrustedDomain,
  PROPLANING_AG_KEY,
  PROPLANING_AG_COMPANY_NAME,
} from './lib/proplaning-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PROPLANING_AG_KEY,
  companyLabel: PROPLANING_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllProplaningAgJobs,
  isCompanyJob: isProplaningAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Proplaning AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
