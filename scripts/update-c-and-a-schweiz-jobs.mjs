#!/usr/bin/env node
/**
 * Dedicated C&A Schweiz crawler runner.
 *
 * Uses the standard crawler template with the C&A Schweiz parser.
 * All fetch/parse logic lives in ./lib/c-and-a-schweiz-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCAndASchweizJobs,
  isCAndASchweizJob,
  isTrustedDomain,
  C_AND_A_SCHWEIZ_KEY,
  C_AND_A_SCHWEIZ_COMPANY_NAME,
} from './lib/c-and-a-schweiz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: C_AND_A_SCHWEIZ_KEY,
  companyLabel: C_AND_A_SCHWEIZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCAndASchweizJobs,
  isCompanyJob: isCAndASchweizJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ C&A Schweiz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
