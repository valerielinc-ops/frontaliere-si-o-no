#!/usr/bin/env node
/**
 * Dedicated Ibis Budget crawler runner.
 *
 * Uses the standard crawler template with the Ibis Budget parser.
 * All fetch/parse logic lives in ./lib/accor-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAccorJobs,
  isAccorJob,
  isTrustedDomain,
  ACCOR_KEY,
  ACCOR_COMPANY_NAME,
} from './lib/accor-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ACCOR_KEY,
  companyLabel: ACCOR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAccorJobs,
  isCompanyJob: isAccorJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Ibis Budget crawler failed: ${err?.message || err}`);
  process.exit(1);
});
