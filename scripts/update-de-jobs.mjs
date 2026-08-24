#!/usr/bin/env node
/**
 * Dedicated MPI AGE crawler runner.
 *
 * Uses the standard crawler template with the MPI AGE parser.
 * All fetch/parse logic lives in ./lib/de-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDeJobs,
  isDeJob,
  isTrustedDomain,
  DE_KEY,
  DE_COMPANY_NAME,
} from './lib/de-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DE_KEY,
  companyLabel: DE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDeJobs,
  isCompanyJob: isDeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ MPI AGE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
