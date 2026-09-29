#!/usr/bin/env node
/**
 * Dedicated Bobst crawler runner.
 *
 * Uses the standard crawler template with the Bobst parser.
 * All fetch/parse logic lives in ./lib/bobst-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBobstJobs,
  isBobstJob,
  isTrustedDomain,
  BOBST_KEY,
  BOBST_COMPANY_NAME,
} from './lib/bobst-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BOBST_KEY,
  companyLabel: BOBST_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBobstJobs,
  isCompanyJob: isBobstJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bobst crawler failed: ${err?.message || err}`);
  process.exit(1);
});
