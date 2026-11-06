#!/usr/bin/env node
/**
 * Dedicated Salina Rehaklinik Rheinfelden crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSalinaRehaJobs,
  isSalinaRehaJob,
  isTrustedDomain,
  SALINA_REHA_KEY,
  SALINA_REHA_COMPANY_NAME,
} from './lib/salina-reha-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SALINA_REHA_KEY,
  companyLabel: SALINA_REHA_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSalinaRehaJobs,
  isCompanyJob: isSalinaRehaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Salina Rehaklinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
