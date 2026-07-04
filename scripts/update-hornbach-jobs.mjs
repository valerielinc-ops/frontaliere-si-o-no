#!/usr/bin/env node
/**
 * Dedicated Hornbach crawler runner.
 *
 * Uses the standard crawler template with the Hornbach parser.
 * All fetch/parse logic lives in ./lib/hornbach-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHornbachJobs,
  isHornbachJob,
  isTrustedDomain,
  HORNBACH_KEY,
  HORNBACH_COMPANY_NAME,
} from './lib/hornbach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HORNBACH_KEY,
  companyLabel: HORNBACH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHornbachJobs,
  isCompanyJob: isHornbachJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Hornbach crawler failed: ${err?.message || err}`);
  process.exit(1);
});
