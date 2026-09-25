#!/usr/bin/env node
/**
 * Dedicated Fielmann Group crawler runner.
 *
 * Uses the standard crawler template with the Fielmann Group parser.
 * All fetch/parse logic lives in ./lib/fielmann-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFielmannJobs,
  isFielmannJob,
  isTrustedDomain,
  FIELMANN_KEY,
  FIELMANN_COMPANY_NAME,
} from './lib/fielmann-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FIELMANN_KEY,
  companyLabel: FIELMANN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFielmannJobs,
  isCompanyJob: isFielmannJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Fielmann Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
