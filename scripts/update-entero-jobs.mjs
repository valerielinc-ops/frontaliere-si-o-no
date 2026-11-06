#!/usr/bin/env node
/**
 * Dedicated entero crawler runner.
 *
 * Uses the standard crawler template with the entero parser.
 * All fetch/parse logic lives in ./lib/entero-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEnteroJobs,
  isEnteroJob,
  isTrustedDomain,
  ENTERO_KEY,
  ENTERO_COMPANY_NAME,
} from './lib/entero-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ENTERO_KEY,
  companyLabel: ENTERO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEnteroJobs,
  isCompanyJob: isEnteroJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ entero crawler failed: ${err?.message || err}`);
  process.exit(1);
});
