#!/usr/bin/env node
/**
 * Dedicated Richemont crawler runner.
 *
 * Uses the standard crawler template with the Richemont parser.
 * All fetch/parse logic lives in ./lib/richemont-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRichemontJobs,
  isRichemontJob,
  isTrustedDomain,
  RICHEMONT_KEY,
  RICHEMONT_COMPANY_NAME,
} from './lib/richemont-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RICHEMONT_KEY,
  companyLabel: RICHEMONT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRichemontJobs,
  isCompanyJob: isRichemontJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Richemont crawler failed: ${err?.message || err}`);
  process.exit(1);
});
