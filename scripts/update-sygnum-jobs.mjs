#!/usr/bin/env node
/**
 * Dedicated Sygnum crawler runner.
 *
 * Uses the standard crawler template with the Sygnum parser.
 * All fetch/parse logic lives in ./lib/sygnum-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSygnumJobs,
  isSygnumJob,
  isTrustedDomain,
  SYGNUM_KEY,
  SYGNUM_COMPANY_NAME,
} from './lib/sygnum-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SYGNUM_KEY,
  companyLabel: SYGNUM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSygnumJobs,
  isCompanyJob: isSygnumJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Sygnum crawler failed: ${err?.message || err}`);
  process.exit(1);
});
