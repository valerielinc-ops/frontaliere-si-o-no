#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGipoJobs,
  isGipoJob,
  isTrustedDomain,
  GIPO_KEY,
  GIPO_COMPANY_NAME,
} from './lib/gipo-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: GIPO_KEY,
  companyLabel: GIPO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGipoJobs,
  isCompanyJob: isGipoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ GIPO crawler failed: ${err?.message || err}`);
  process.exit(1);
});

