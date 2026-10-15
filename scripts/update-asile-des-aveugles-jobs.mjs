#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  ASILE_DES_AVEUGLES_COMPANY_NAME,
  ASILE_DES_AVEUGLES_KEY,
  fetchAllAsileDesAveuglesJobs,
  isAsileDesAveuglesJob,
  isTrustedDomain,
} from './lib/asile-des-aveugles-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: ASILE_DES_AVEUGLES_KEY,
  companyLabel: ASILE_DES_AVEUGLES_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAsileDesAveuglesJobs,
  isCompanyJob: isAsileDesAveuglesJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((error) => {
  console.error(`Asile des aveugles crawler failed: ${error?.message || error}`);
  process.exit(1);
});
