#!/usr/bin/env node
/**
 * Dedicated Tschuggen Collection crawler runner.
 *
 * Uses the standard crawler template with the Tschuggen Collection parser.
 * All fetch/parse logic lives in ./lib/tschuggen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTschuggenJobs,
  isTschuggenJob,
  isTrustedDomain,
  TSCHUGGEN_KEY,
  TSCHUGGEN_COMPANY_NAME,
} from './lib/tschuggen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TSCHUGGEN_KEY,
  companyLabel: TSCHUGGEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTschuggenJobs,
  isCompanyJob: isTschuggenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Tschuggen Collection crawler failed: ${err?.message || err}`);
  process.exit(1);
});
