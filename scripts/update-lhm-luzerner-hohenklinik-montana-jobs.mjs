#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLhmJobs,
  isLhmJob,
  isTrustedDomain,
  LHM_KEY,
  LHM_COMPANY_NAME,
} from './lib/lhm-luzerner-hohenklinik-montana-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: LHM_KEY,
  companyLabel: LHM_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllLhmJobs,
  isCompanyJob: isLhmJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ LHM crawler failed: ${err?.message || err}`); process.exit(1); });
