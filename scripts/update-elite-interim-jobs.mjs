#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  ELITE_INTERIM_KEY,
  ELITE_INTERIM_COMPANY_NAME,
  fetchAllEliteInterimJobs,
  isEliteInterimJob,
  isTrustedDomain,
} from './lib/elite-interim-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ELITE_INTERIM_KEY,
  companyLabel: ELITE_INTERIM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEliteInterimJobs,
  isCompanyJob: isEliteInterimJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((error) => {
  console.error(`Elite Interim crawler failed: ${error?.message || error}`);
  process.exit(1);
});
