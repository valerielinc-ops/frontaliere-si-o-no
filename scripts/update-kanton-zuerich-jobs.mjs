#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonZuerichJobs,
  isKantonZuerichJob,
  isTrustedDomain,
  KANTON_ZUERICH_KEY,
  KANTON_ZUERICH_COMPANY_NAME,
} from './lib/kanton-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KANTON_ZUERICH_KEY,
  companyLabel: KANTON_ZUERICH_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKantonZuerichJobs,
  isCompanyJob: isKantonZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kanton Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
