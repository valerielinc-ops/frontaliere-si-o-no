#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPfisterJobs,
  isPfisterJob,
  isTrustedDomain,
  PFISTER_KEY,
  PFISTER_COMPANY_NAME,
} from './lib/pfister-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: PFISTER_KEY,
  companyLabel: PFISTER_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllPfisterJobs,
  isCompanyJob: isPfisterJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Pfister crawler failed: ${err?.message || err}`); process.exit(1); });
