#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAlconJobs,
  isAlconJob,
  isTrustedDomain,
  ALCON_KEY,
  ALCON_COMPANY_NAME,
} from './lib/alcon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ALCON_KEY,
  companyLabel: ALCON_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllAlconJobs,
  isCompanyJob: isAlconJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Alcon crawler failed: ${err?.message || err}`); process.exit(1); });
