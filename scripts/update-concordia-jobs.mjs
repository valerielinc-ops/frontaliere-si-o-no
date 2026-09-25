#!/usr/bin/env node
/**
 * Dedicated Concordia crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllConcordiaJobs,
  isConcordiaJob,
  isTrustedDomain,
  CONCORDIA_KEY,
  CONCORDIA_COMPANY_NAME,
} from './lib/concordia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CONCORDIA_KEY,
  companyLabel: CONCORDIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllConcordiaJobs,
  isCompanyJob: isConcordiaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Concordia crawler failed: ${err?.message || err}`);
  process.exit(1);
});
