#!/usr/bin/env node
/**
 * Dedicated Geberit crawler runner.
 *
 * Uses the standard crawler template with the Geberit parser.
 * All fetch/parse logic lives in ./lib/geberit-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGeberitJobs,
  isGeberitJob,
  isTrustedDomain,
  GEBERIT_KEY,
  GEBERIT_COMPANY_NAME,
} from './lib/geberit-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GEBERIT_KEY,
  companyLabel: GEBERIT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGeberitJobs,
  isCompanyJob: isGeberitJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Geberit crawler failed: ${err?.message || err}`);
  process.exit(1);
});
