#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/hilti-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHiltiJobs,
  isHiltiJob,
  isTrustedDomain,
  HILTI_KEY,
  HILTI_COMPANY_NAME,
} from './lib/hilti-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HILTI_KEY,
  companyLabel: HILTI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHiltiJobs,
  isCompanyJob: isHiltiJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
