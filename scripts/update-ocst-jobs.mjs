#!/usr/bin/env node
/**
 * Dedicated OCST crawler runner.
 *
 * Uses the standard crawler template with the OCST parser.
 * All fetch/parse logic lives in ./lib/ocst-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOcstJobs,
  assertCompleteOcstSnapshot,
  isOcstJob,
  isTrustedDomain,
  OCST_KEY,
  OCST_COMPANY_NAME,
} from './lib/ocst-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OCST_KEY,
  companyLabel: OCST_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOcstJobs,
  isCompanyJob: isOcstJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  validateAuthoritativeSnapshot: assertCompleteOcstSnapshot,
  allowAuthoritativeEmptySnapshot: true,
}).catch((err) => {
  console.error(`❌ OCST crawler failed: ${err?.message || err}`);
  process.exit(1);
});
