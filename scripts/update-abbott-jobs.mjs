#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAbbottJobs,
  isAbbottJob,
  isTrustedDomain,
  ABBOTT_KEY,
  ABBOTT_COMPANY_NAME,
} from './lib/abbott-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ABBOTT_KEY,
  companyLabel: ABBOTT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllAbbottJobs,
  isCompanyJob: isAbbottJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => { console.error(`❌ Abbott crawler failed: ${err?.message || err}`); process.exit(1); });
