#!/usr/bin/env node
/**
 * Dedicated Stadt Bern crawler runner.
 *
 * Uses the standard crawler template with the Stadt Bern parser.
 * All fetch/parse logic lives in ./lib/stadt-bern-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStadtBernJobs,
  isStadtBernJob,
  isTrustedDomain,
  STADT_BERN_KEY,
  STADT_BERN_COMPANY_NAME,
} from './lib/stadt-bern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STADT_BERN_KEY,
  companyLabel: STADT_BERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStadtBernJobs,
  isCompanyJob: isStadtBernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stadt Bern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
