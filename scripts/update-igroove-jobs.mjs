#!/usr/bin/env node
/**
 * Dedicated iGroove crawler runner.
 *
 * Uses the standard crawler template with the iGroove parser.
 * All fetch/parse logic lives in ./lib/igroove-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIgrooveJobs,
  isIgrooveJob,
  isTrustedDomain,
  IGROOVE_KEY,
  IGROOVE_COMPANY_NAME,
} from './lib/igroove-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IGROOVE_KEY,
  companyLabel: IGROOVE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIgrooveJobs,
  isCompanyJob: isIgrooveJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ iGroove crawler failed: ${err?.message || err}`);
  process.exit(1);
});
