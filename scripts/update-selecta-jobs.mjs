#!/usr/bin/env node
/**
 * Dedicated Selecta AG crawler runner.
 *
 * Uses the standard crawler template with the Selecta parser.
 * All fetch/parse logic lives in ./lib/selecta-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSelectaJobs,
  isSelectaJob,
  isTrustedDomain,
  SELECTA_KEY,
  SELECTA_COMPANY_NAME,
} from './lib/selecta-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SELECTA_KEY,
  companyLabel: SELECTA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSelectaJobs,
  isCompanyJob: isSelectaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Selecta crawler failed: ${err?.message || err}`);
  process.exit(1);
});
