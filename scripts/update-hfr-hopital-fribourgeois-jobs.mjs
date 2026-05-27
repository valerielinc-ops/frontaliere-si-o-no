#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHfrJobs,
  isHfrJob,
  isTrustedDomain,
  HFR_KEY,
  HFR_COMPANY_NAME,
} from './lib/hfr-hopital-fribourgeois-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: HFR_KEY,
  companyLabel: HFR_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllHfrJobs,
  isCompanyJob: isHfrJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ HFR crawler failed: ${err?.message || err}`); process.exit(1); });
