#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGzDielsdorfJobs,
  isGzDielsdorfJob,
  isTrustedDomain,
  GZ_DIELSDORF_KEY,
  GZ_DIELSDORF_COMPANY_NAME,
} from './lib/gz-dielsdorf-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: GZ_DIELSDORF_KEY,
  companyLabel: GZ_DIELSDORF_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllGzDielsdorfJobs,
  isCompanyJob: isGzDielsdorfJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ GZ Dielsdorf crawler failed: ${err?.message || err}`); process.exit(1); });
