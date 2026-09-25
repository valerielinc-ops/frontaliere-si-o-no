#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDalerJobs,
  isDalerJob,
  isTrustedDomain,
  DALER_KEY,
  DALER_COMPANY_NAME,
} from './lib/daler-hopital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: DALER_KEY,
  companyLabel: DALER_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllDalerJobs,
  isCompanyJob: isDalerJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ Daler crawler failed: ${err?.message || err}`); process.exit(1); });
