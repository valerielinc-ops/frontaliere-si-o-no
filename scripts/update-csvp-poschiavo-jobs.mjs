#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsvpPoschiavoJobs,
  isCsvpPoschiavoJob,
  isTrustedDomain,
  CSVP_POSCHIAVO_KEY,
  CSVP_POSCHIAVO_COMPANY_NAME,
} from './lib/csvp-poschiavo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CSVP_POSCHIAVO_KEY,
  companyLabel: CSVP_POSCHIAVO_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCsvpPoschiavoJobs,
  isCompanyJob: isCsvpPoschiavoJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => { console.error(`❌ CSVP crawler failed: ${err?.message || err}`); process.exit(1); });
