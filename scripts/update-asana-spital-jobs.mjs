#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAsanaSpitalJobs,
  isAsanaSpitalJob,
  isTrustedDomain,
  ASANA_SPITAL_KEY,
  ASANA_SPITAL_COMPANY_NAME,
} from './lib/asana-spital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ASANA_SPITAL_KEY,
  companyLabel: ASANA_SPITAL_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllAsanaSpitalJobs,
  isCompanyJob: isAsanaSpitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ asana Spital crawler failed: ${err?.message || err}`); process.exit(1); });
