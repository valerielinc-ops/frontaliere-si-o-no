#!/usr/bin/env node
/**
 * Dedicated Deloitte crawler runner.
 *
 * Uses the standard crawler template with the Deloitte parser.
 * All fetch/parse logic lives in ./lib/deloitte-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDeloitteJobs,
  isDeloitteJob,
  isTrustedDomain,
  DELOITTE_KEY,
  DELOITTE_COMPANY_NAME,
} from './lib/deloitte-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DELOITTE_KEY,
  companyLabel: DELOITTE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDeloitteJobs,
  isCompanyJob: isDeloitteJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Deloitte crawler failed: ${err?.message || err}`);
  process.exit(1);
});
