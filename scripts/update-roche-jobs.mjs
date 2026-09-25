#!/usr/bin/env node
/**
 * Dedicated Roche crawler runner.
 *
 * Uses the standard crawler template with the Roche parser.
 * All fetch/parse logic lives in ./lib/roche-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRocheJobs,
  isRocheJob,
  isTrustedDomain,
  ROCHE_KEY,
  ROCHE_COMPANY_NAME,
} from './lib/roche-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ROCHE_KEY,
  companyLabel: ROCHE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRocheJobs,
  isCompanyJob: isRocheJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Roche crawler failed: ${err?.message || err}`);
  process.exit(1);
});
