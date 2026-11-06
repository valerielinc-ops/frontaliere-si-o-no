#!/usr/bin/env node
/**
 * Dedicated Psychiatrie Baselland (PBL) crawler runner.
 *
 * Uses the standard crawler template with the PBL parser. All fetch/parse
 * logic lives in ./lib/pbl-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPblJobs,
  isPblJob,
  isTrustedDomain,
  PBL_KEY,
  PBL_COMPANY_NAME,
} from './lib/pbl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PBL_KEY,
  companyLabel: PBL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPblJobs,
  isCompanyJob: isPblJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Psychiatrie Baselland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
