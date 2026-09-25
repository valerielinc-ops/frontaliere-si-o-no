#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPukZuerichJobs,
  isPukZuerichJob,
  isTrustedDomain,
  PUK_ZUERICH_KEY,
  PUK_ZUERICH_COMPANY_NAME,
} from './lib/puk-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: PUK_ZUERICH_KEY,
  companyLabel: PUK_ZUERICH_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllPukZuerichJobs,
  isCompanyJob: isPukZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ PUK Zürich crawler failed: ${err?.message || err}`); process.exit(1); });
