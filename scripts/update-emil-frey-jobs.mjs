#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/emil-frey-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEmilFreyJobs,
  isEmilFreyJob,
  isTrustedDomain,
  EMIL_FREY_KEY,
  EMIL_FREY_COMPANY_NAME,
} from './lib/emil-frey-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EMIL_FREY_KEY,
  companyLabel: EMIL_FREY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEmilFreyJobs,
  isCompanyJob: isEmilFreyJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
