#!/usr/bin/env node
/**
 * Dedicated TALLY WEiJL crawler runner.
 *
 * Uses the standard crawler template with the TALLY WEiJL parser.
 * All fetch/parse logic lives in ./lib/tally-weijl-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTallyWeijlJobs,
  isTallyWeijlJob,
  isTrustedDomain,
  TALLY_WEIJL_KEY,
  TALLY_WEIJL_COMPANY_NAME,
} from './lib/tally-weijl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TALLY_WEIJL_KEY,
  companyLabel: TALLY_WEIJL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTallyWeijlJobs,
  isCompanyJob: isTallyWeijlJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ TALLY WEiJL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
