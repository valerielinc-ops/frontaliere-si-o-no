#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZkbJobs,
  isZkbJob,
  isTrustedDomain,
  ZKB_KEY,
  ZKB_COMPANY_NAME,
} from './lib/zkb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ZKB_KEY,
  companyLabel: ZKB_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllZkbJobs,
  isCompanyJob: isZkbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ ZKB crawler failed: ${err?.message || err}`); process.exit(1); });
