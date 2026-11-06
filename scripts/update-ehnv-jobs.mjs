#!/usr/bin/env node
/**
 * Dedicated eHnv (Étab. Hospitaliers du Nord Vaudois) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEhnvJobs,
  isEhnvJob,
  isTrustedDomain,
  EHNV_KEY,
  EHNV_COMPANY_NAME,
} from './lib/ehnv-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EHNV_KEY,
  companyLabel: EHNV_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEhnvJobs,
  isCompanyJob: isEhnvJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ eHnv crawler failed: ${err?.message || err}`);
  process.exit(1);
});
