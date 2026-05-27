#!/usr/bin/env node
/**
 * Dedicated Mabetex Group crawler runner.
 *
 * Uses the standard crawler template with the Mabetex Group parser.
 * All fetch/parse logic lives in ./lib/mabetex-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMabetexJobs,
  isMabetexJob,
  isTrustedDomain,
  MABETEX_KEY,
  MABETEX_COMPANY_NAME,
} from './lib/mabetex-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MABETEX_KEY,
  companyLabel: MABETEX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMabetexJobs,
  isCompanyJob: isMabetexJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Mabetex Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
