#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsBregagliaJobs,
  isCsBregagliaJob,
  isTrustedDomain,
  CS_BREGAGLIA_KEY,
  CS_BREGAGLIA_COMPANY_NAME,
} from './lib/cs-bregaglia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CS_BREGAGLIA_KEY,
  companyLabel: CS_BREGAGLIA_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCsBregagliaJobs,
  isCompanyJob: isCsBregagliaJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => { console.error(`❌ CS Bregaglia crawler failed: ${err?.message || err}`); process.exit(1); });
