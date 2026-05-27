#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStrykerJobs,
  isStrykerJob,
  isTrustedDomain,
  STRYKER_KEY,
  STRYKER_COMPANY_NAME,
} from './lib/stryker-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: STRYKER_KEY,
  companyLabel: STRYKER_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllStrykerJobs,
  isCompanyJob: isStrykerJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => { console.error(`❌ Stryker crawler failed: ${err?.message || err}`); process.exit(1); });
