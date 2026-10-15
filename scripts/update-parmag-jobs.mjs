#!/usr/bin/env node
/**
 * Dedicated ParMag AG crawler runner.
 *
 * Uses the standard crawler template with the ParMag AG parser.
 * All fetch/parse logic lives in ./lib/parmag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllParmagJobs,
  isParmagJob,
  isTrustedDomain,
  PARMAG_KEY,
  PARMAG_COMPANY_NAME,
} from './lib/parmag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PARMAG_KEY,
  companyLabel: PARMAG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllParmagJobs,
  isCompanyJob: isParmagJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ParMag AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
