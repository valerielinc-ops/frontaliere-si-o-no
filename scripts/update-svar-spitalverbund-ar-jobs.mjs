#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSvarJobs,
  isSvarJob,
  isTrustedDomain,
  SVAR_KEY,
  SVAR_COMPANY_NAME,
} from './lib/svar-spitalverbund-ar-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SVAR_KEY,
  companyLabel: SVAR_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSvarJobs,
  isCompanyJob: isSvarJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SVAR crawler failed: ${err?.message || err}`);
  process.exit(1);
});
