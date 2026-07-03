#!/usr/bin/env node
/**
 * Dedicated Talan crawler runner.
 *
 * Uses the standard crawler template with the Talan parser.
 * All fetch/parse logic lives in ./lib/talan-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTalanJobs,
  isTalanJob,
  isTrustedDomain,
  TALAN_KEY,
  TALAN_COMPANY_NAME,
} from './lib/talan-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TALAN_KEY,
  companyLabel: TALAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTalanJobs,
  isCompanyJob: isTalanJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Talan crawler failed: ${err?.message || err}`);
  process.exit(1);
});
