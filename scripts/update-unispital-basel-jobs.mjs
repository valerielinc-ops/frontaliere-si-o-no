#!/usr/bin/env node
/**
 * Dedicated Universitätsspital Basel crawler runner.
 *
 * Uses the standard crawler template with the Universitätsspital Basel parser.
 * All fetch/parse logic lives in ./lib/unispital-basel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUnispitalBaselJobs,
  isUnispitalBaselJob,
  isTrustedDomain,
  UNISPITAL_BASEL_KEY,
  UNISPITAL_BASEL_COMPANY_NAME,
} from './lib/unispital-basel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UNISPITAL_BASEL_KEY,
  companyLabel: UNISPITAL_BASEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUnispitalBaselJobs,
  isCompanyJob: isUnispitalBaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Universitätsspital Basel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
