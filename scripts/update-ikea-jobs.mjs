#!/usr/bin/env node
/**
 * Dedicated IKEA crawler runner.
 *
 * Uses the standard crawler template with the IKEA parser.
 * All fetch/parse logic lives in ./lib/ikea-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIkeaJobs,
  isIkeaJob,
  isTrustedDomain,
  IKEA_KEY,
  IKEA_COMPANY_NAME,
} from './lib/ikea-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IKEA_KEY,
  companyLabel: IKEA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIkeaJobs,
  isCompanyJob: isIkeaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ IKEA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
