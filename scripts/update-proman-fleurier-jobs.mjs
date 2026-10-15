#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPromanFleurierJobs,
  isPromanFleurierJob,
  isTrustedDomain,
  PROMAN_FLEURIER_KEY,
  PROMAN_FLEURIER_COMPANY_NAME,
} from './lib/proman-fleurier-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: PROMAN_FLEURIER_KEY,
  companyLabel: PROMAN_FLEURIER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPromanFleurierJobs,
  isCompanyJob: isPromanFleurierJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ PROMAN Fleurier crawler failed: ${err?.message || err}`);
  process.exit(1);
});
