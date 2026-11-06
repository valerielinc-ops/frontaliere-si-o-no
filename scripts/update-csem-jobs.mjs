#!/usr/bin/env node
/**
 * Dedicated CSEM Landquart crawler runner.
 *
 * Uses the standard crawler template with the CSEM Landquart parser.
 * All fetch/parse logic lives in ./lib/csem-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsemJobs,
  isCsemJob,
  isTrustedDomain,
  CSEM_KEY,
  CSEM_COMPANY_NAME,
} from './lib/csem-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CSEM_KEY,
  companyLabel: CSEM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCsemJobs,
  isCompanyJob: isCsemJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ CSEM Landquart crawler failed: ${err?.message || err}`);
  process.exit(1);
});
