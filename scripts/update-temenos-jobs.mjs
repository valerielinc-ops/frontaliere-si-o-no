#!/usr/bin/env node
/**
 * Dedicated Temenos crawler runner.
 *
 * Uses the standard crawler template with the Temenos parser.
 * All fetch/parse logic lives in ./lib/temenos-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTemenosJobs,
  isTemenosJob,
  isTrustedDomain,
  TEMENOS_KEY,
  TEMENOS_COMPANY_NAME,
} from './lib/temenos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TEMENOS_KEY,
  companyLabel: TEMENOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTemenosJobs,
  isCompanyJob: isTemenosJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Temenos crawler failed: ${err?.message || err}`);
  process.exit(1);
});
