#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSohJobs,
  isSohJob,
  isTrustedDomain,
  SOH_KEY,
  SOH_COMPANY_NAME,
} from './lib/soh-solothurner-spitaeler-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SOH_KEY,
  companyLabel: SOH_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSohJobs,
  isCompanyJob: isSohJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ SOH crawler failed: ${err?.message || err}`); process.exit(1); });
