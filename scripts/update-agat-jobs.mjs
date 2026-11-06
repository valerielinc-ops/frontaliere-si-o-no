#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAgatJobs,
  isAgatJob,
  isTrustedDomain,
  AGAT_KEY,
  AGAT_COMPANY_NAME,
} from './lib/agat-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: AGAT_KEY,
  companyLabel: AGAT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAgatJobs,
  isCompanyJob: isAgatJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ AGAT! crawler failed: ${err?.message || err}`);
  process.exit(1);
});
