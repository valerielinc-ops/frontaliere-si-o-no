#!/usr/bin/env node
/**
 * Dedicated Bachem crawler runner.
 *
 * Uses the standard crawler template with the Bachem parser.
 * All fetch/parse logic lives in ./lib/bachem-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBachemJobs,
  isBachemJob,
  isTrustedDomain,
  BACHEM_KEY,
  BACHEM_COMPANY_NAME,
} from './lib/bachem-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BACHEM_KEY,
  companyLabel: BACHEM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBachemJobs,
  isCompanyJob: isBachemJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bachem crawler failed: ${err?.message || err}`);
  process.exit(1);
});
