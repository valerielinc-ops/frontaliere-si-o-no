#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSiemensJobs,
  isSiemensJob,
  isTrustedDomain,
  SIEMENS_KEY,
  SIEMENS_COMPANY_NAME,
} from './lib/siemens-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIEMENS_KEY,
  companyLabel: SIEMENS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSiemensJobs,
  isCompanyJob: isSiemensJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Siemens crawler failed: ${err?.message || err}`);
  process.exit(1);
});
