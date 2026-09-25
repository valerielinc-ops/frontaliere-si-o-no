#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCslBehringJobs,
  isCslBehringJob,
  isTrustedDomain,
  CSL_BEHRING_KEY,
  CSL_BEHRING_COMPANY_NAME,
} from './lib/csl-behring-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CSL_BEHRING_KEY,
  companyLabel: CSL_BEHRING_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCslBehringJobs,
  isCompanyJob: isCslBehringJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => { console.error(`❌ CSL Behring crawler failed: ${err?.message || err}`); process.exit(1); });
