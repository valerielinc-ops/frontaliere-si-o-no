#!/usr/bin/env node
/**
 * Dedicated Sika AG crawler runner.
 *
 * Uses the standard crawler template with the Sika AG parser.
 * All fetch/parse logic lives in ./lib/sika-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSikaJobs,
  isSikaJob,
  isTrustedDomain,
  SIKA_KEY,
  SIKA_COMPANY_NAME,
} from './lib/sika-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIKA_KEY,
  companyLabel: SIKA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSikaJobs,
  isCompanyJob: isSikaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Sika AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
