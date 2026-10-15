#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSympajobsReinachBlJobs,
  isSympajobsReinachBlJob,
  isTrustedDomain,
  SYMPAJOBS_REINACH_BL_KEY,
  SYMPAJOBS_REINACH_BL_COMPANY_NAME,
} from './lib/sympajobs-reinach-bl-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: SYMPAJOBS_REINACH_BL_KEY,
  companyLabel: SYMPAJOBS_REINACH_BL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSympajobsReinachBlJobs,
  isCompanyJob: isSympajobsReinachBlJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Sympajobs crawler failed: ${err?.message || err}`);
  process.exit(1);
});
