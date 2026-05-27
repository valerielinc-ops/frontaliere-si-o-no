#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitexZuerichJobs,
  isSpitexZuerichJob,
  isTrustedDomain,
  SPITEX_ZUERICH_KEY,
  SPITEX_ZUERICH_COMPANY_NAME,
} from './lib/spitex-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SPITEX_ZUERICH_KEY,
  companyLabel: SPITEX_ZUERICH_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSpitexZuerichJobs,
  isCompanyJob: isSpitexZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Spitex Zürich crawler failed: ${err?.message || err}`); process.exit(1); });
