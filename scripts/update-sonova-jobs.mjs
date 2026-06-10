#!/usr/bin/env node
/**
 * Dedicated undefined crawler runner.
 *
 * Uses the standard crawler template with the undefined parser.
 * All fetch/parse logic lives in ./lib/sonova-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSonovaJobs,
  isSonovaJob,
  isTrustedDomain,
  SONOVA_KEY,
  SONOVA_COMPANY_NAME,
} from './lib/sonova-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SONOVA_KEY,
  companyLabel: SONOVA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSonovaJobs,
  isCompanyJob: isSonovaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ undefined crawler failed: ${err?.message || err}`);
  process.exit(1);
});
