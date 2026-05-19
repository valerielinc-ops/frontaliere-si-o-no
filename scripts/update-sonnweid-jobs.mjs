#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSonnweidJobs,
  isSonnweidJob,
  isTrustedDomain,
  SONNWEID_KEY,
  SONNWEID_COMPANY_NAME,
} from './lib/sonnweid-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SONNWEID_KEY,
  companyLabel: SONNWEID_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSonnweidJobs,
  isCompanyJob: isSonnweidJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Sonnweid crawler failed: ${err?.message || err}`); process.exit(1); });
