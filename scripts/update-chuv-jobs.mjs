#!/usr/bin/env node
/**
 * Dedicated CHUV crawler runner.
 *
 * Uses the standard crawler template with the CHUV parser.
 * All fetch/parse logic lives in ./lib/chuv-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChuvJobs,
  isChuvJob,
  isTrustedDomain,
  CHUV_KEY,
  CHUV_COMPANY_NAME,
} from './lib/chuv-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CHUV_KEY,
  companyLabel: CHUV_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChuvJobs,
  isCompanyJob: isChuvJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ CHUV crawler failed: ${err?.message || err}`);
  process.exit(1);
});
