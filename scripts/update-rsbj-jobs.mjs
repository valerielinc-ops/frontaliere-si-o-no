#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRsbjJobs,
  isRsbjJob,
  isTrustedDomain,
  RSBJ_KEY,
  RSBJ_COMPANY_NAME,
} from './lib/rsbj-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: RSBJ_KEY,
  companyLabel: RSBJ_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRsbjJobs,
  isCompanyJob: isRsbjJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ RSBJ crawler failed: ${err?.message || err}`); process.exit(1); });
