#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRaiffeisenJobs,
  isRaiffeisenJob,
  isTrustedDomain,
  RAIFFEISEN_KEY,
  RAIFFEISEN_COMPANY_NAME,
} from './lib/raiffeisen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: RAIFFEISEN_KEY,
  companyLabel: RAIFFEISEN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRaiffeisenJobs,
  isCompanyJob: isRaiffeisenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Raiffeisen crawler failed: ${err?.message || err}`); process.exit(1); });
