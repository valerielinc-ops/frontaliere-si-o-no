#!/usr/bin/env node
/**
 * Dedicated FISBA AG crawler runner.
 *
 * Uses the standard crawler template with the FISBA AG parser.
 * All fetch/parse logic lives in ./lib/fisba-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFisbaJobs,
  isFisbaJob,
  isTrustedDomain,
  FISBA_KEY,
  FISBA_COMPANY_NAME,
} from './lib/fisba-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FISBA_KEY,
  companyLabel: FISBA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFisbaJobs,
  isCompanyJob: isFisbaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ FISBA AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
