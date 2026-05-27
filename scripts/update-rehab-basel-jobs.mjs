#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehabBaselJobs,
  isRehabBaselJob,
  isTrustedDomain,
  REHAB_BASEL_KEY,
  REHAB_BASEL_COMPANY_NAME,
} from './lib/rehab-basel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: REHAB_BASEL_KEY,
  companyLabel: REHAB_BASEL_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRehabBaselJobs,
  isCompanyJob: isRehabBaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ REHAB Basel crawler failed: ${err?.message || err}`); process.exit(1); });
