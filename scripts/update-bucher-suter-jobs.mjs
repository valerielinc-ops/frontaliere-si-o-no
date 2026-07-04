#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBucherSuterJobs,
  isBucherSuterJob,
  isTrustedDomain,
  BUCHER_SUTER_KEY,
  BUCHER_SUTER_COMPANY_NAME,
} from './lib/bucher-suter-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUCHER_SUTER_KEY,
  companyLabel: BUCHER_SUTER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBucherSuterJobs,
  isCompanyJob: isBucherSuterJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bucher + Suter AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
