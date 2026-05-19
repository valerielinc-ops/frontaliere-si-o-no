#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsvmMustairJobs,
  isCsvmMustairJob,
  isTrustedDomain,
  CSVM_MUSTAIR_KEY,
  CSVM_MUSTAIR_COMPANY_NAME,
} from './lib/csvm-mustair-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CSVM_MUSTAIR_KEY,
  companyLabel: CSVM_MUSTAIR_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCsvmMustairJobs,
  isCompanyJob: isCsvmMustairJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ CSVM crawler failed: ${err?.message || err}`); process.exit(1); });
