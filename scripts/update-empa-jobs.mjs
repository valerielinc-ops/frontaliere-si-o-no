#!/usr/bin/env node
/**
 * Dedicated Empa crawler runner.
 *
 * Uses the standard crawler template with the Empa parser.
 * All fetch/parse logic lives in ./lib/empa-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEmpaJobs,
  isEmpaJob,
  isTrustedDomain,
  EMPA_KEY,
  EMPA_COMPANY_NAME,
} from './lib/empa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EMPA_KEY,
  companyLabel: EMPA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEmpaJobs,
  isCompanyJob: isEmpaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Empa crawler failed: ${err?.message || err}`);
  process.exit(1);
});
