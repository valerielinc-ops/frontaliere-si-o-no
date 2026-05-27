#!/usr/bin/env node
/**
 * Dedicated EPFL crawler runner.
 *
 * Uses the standard crawler template with the EPFL parser.
 * All fetch/parse logic lives in ./lib/epfl-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEpflJobs,
  isEpflJob,
  isTrustedDomain,
  EPFL_KEY,
  EPFL_COMPANY_NAME,
} from './lib/epfl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EPFL_KEY,
  companyLabel: EPFL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEpflJobs,
  isCompanyJob: isEpflJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ EPFL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
