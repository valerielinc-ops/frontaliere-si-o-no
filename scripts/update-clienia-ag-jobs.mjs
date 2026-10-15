#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCleniaAgJobs,
  isCleniaAgJob,
  isTrustedDomain,
  CLIENIA_AG_KEY,
  CLIENIA_AG_COMPANY_NAME,
} from './lib/clienia-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CLIENIA_AG_KEY,
  companyLabel: CLIENIA_AG_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCleniaAgJobs,
  isCompanyJob: isCleniaAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Clienia AG crawler failed: ${err?.message || err}`); process.exit(1); });
