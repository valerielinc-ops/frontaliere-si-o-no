#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  PROJECT_INTERIM_KEY,
  PROJECT_INTERIM_COMPANY_NAME,
  fetchAllProjectInterimJobs,
  isProjectInterimJob,
  isTrustedDomain,
} from './lib/project-interim-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PROJECT_INTERIM_KEY,
  companyLabel: PROJECT_INTERIM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllProjectInterimJobs,
  isCompanyJob: isProjectInterimJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((error) => {
  console.error(`Project Interim crawler failed: ${error?.message || error}`);
  process.exit(1);
});
