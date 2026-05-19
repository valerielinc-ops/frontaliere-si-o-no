#!/usr/bin/env node
/**
 * Dedicated Schweizer Paraplegiker-Zentrum (SPZ) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpzJobs,
  isSpzJob,
  isTrustedDomain,
  SPZ_KEY,
  SPZ_COMPANY_NAME,
} from './lib/spz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPZ_KEY,
  companyLabel: SPZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpzJobs,
  isCompanyJob: isSpzJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SPZ crawler failed: ${err?.message || err}`);
  process.exit(1);
});
