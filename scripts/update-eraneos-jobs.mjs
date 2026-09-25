#!/usr/bin/env node
/**
 * Dedicated Eraneos crawler runner.
 *
 * Uses the standard crawler template with the Eraneos parser.
 * All fetch/parse logic lives in ./lib/eraneos-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEraneosJobs,
  isEraneosJob,
  isTrustedDomain,
  ERANEOS_KEY,
  ERANEOS_COMPANY_NAME,
} from './lib/eraneos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ERANEOS_KEY,
  companyLabel: ERANEOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEraneosJobs,
  isCompanyJob: isEraneosJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Eraneos crawler failed: ${err?.message || err}`);
  process.exit(1);
});
