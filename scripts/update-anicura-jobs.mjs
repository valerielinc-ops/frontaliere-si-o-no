#!/usr/bin/env node
/**
 * Dedicated anicura crawler runner.
 *
 * Uses the standard crawler template with the anicura parser.
 * All fetch/parse logic lives in ./lib/anicura-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAnicuraJobs,
  isAnicuraJob,
  isTrustedDomain,
  ANICURA_KEY,
  ANICURA_COMPANY_NAME,
} from './lib/anicura-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ANICURA_KEY,
  companyLabel: ANICURA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAnicuraJobs,
  isCompanyJob: isAnicuraJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ anicura crawler failed: ${err?.message || err}`);
  process.exit(1);
});
