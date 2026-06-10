#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/hermes-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHermesJobs,
  isHermesJob,
  isTrustedDomain,
  HERMES_KEY,
  HERMES_COMPANY_NAME,
} from './lib/hermes-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HERMES_KEY,
  companyLabel: HERMES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHermesJobs,
  isCompanyJob: isHermesJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
