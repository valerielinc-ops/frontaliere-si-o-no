#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCicJobs,
  isCicJob,
  isTrustedDomain,
  CIC_KEY,
  CIC_COMPANY_NAME,
} from './lib/clinique-cic-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CIC_KEY,
  companyLabel: CIC_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCicJobs,
  isCompanyJob: isCicJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ Clinique CIC crawler failed: ${err?.message || err}`); process.exit(1); });
