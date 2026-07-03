#!/usr/bin/env node
/**
 * Dedicated Stäubli crawler runner.
 *
 * Uses the standard crawler template with the Stäubli parser.
 * All fetch/parse logic lives in ./lib/staubli-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStaubliJobs,
  isStaubliJob,
  isTrustedDomain,
  STAUBLI_KEY,
  STAUBLI_COMPANY_NAME,
} from './lib/staubli-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STAUBLI_KEY,
  companyLabel: STAUBLI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStaubliJobs,
  isCompanyJob: isStaubliJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stäubli crawler failed: ${err?.message || err}`);
  process.exit(1);
});
