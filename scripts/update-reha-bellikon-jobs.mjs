#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehaBellikonJobs,
  isRehaBellikonJob,
  isTrustedDomain,
  REHA_BELLIKON_KEY,
  REHA_BELLIKON_COMPANY_NAME,
} from './lib/reha-bellikon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: REHA_BELLIKON_KEY,
  companyLabel: REHA_BELLIKON_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRehaBellikonJobs,
  isCompanyJob: isRehaBellikonJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Reha Bellikon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
