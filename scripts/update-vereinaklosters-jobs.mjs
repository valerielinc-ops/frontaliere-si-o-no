#!/usr/bin/env node
/**
 * Dedicated Vereina crawler runner.
 *
 * Uses the standard crawler template with the Vereina parser.
 * All fetch/parse logic lives in ./lib/vereinaklosters-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVereinaklostersJobs,
  isVereinaklostersJob,
  isTrustedDomain,
  VEREINAKLOSTERS_KEY,
  VEREINAKLOSTERS_COMPANY_NAME,
} from './lib/vereinaklosters-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VEREINAKLOSTERS_KEY,
  companyLabel: VEREINAKLOSTERS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVereinaklostersJobs,
  isCompanyJob: isVereinaklostersJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Vereina crawler failed: ${err?.message || err}`);
  process.exit(1);
});
