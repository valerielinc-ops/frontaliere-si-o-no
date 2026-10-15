#!/usr/bin/env node
/**
 * Dedicated Transgourmet crawler runner.
 *
 * Uses the standard crawler template with the Transgourmet parser.
 * All fetch/parse logic lives in ./lib/transgourmet-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTransgourmetJobs,
  isTransgourmetJob,
  isTrustedDomain,
  TRANSGOURMET_KEY,
  TRANSGOURMET_COMPANY_NAME,
} from './lib/transgourmet-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TRANSGOURMET_KEY,
  companyLabel: TRANSGOURMET_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTransgourmetJobs,
  isCompanyJob: isTransgourmetJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Transgourmet crawler failed: ${err?.message || err}`);
  process.exit(1);
});
