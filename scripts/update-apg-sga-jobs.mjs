#!/usr/bin/env node
/**
 * Dedicated APG|SGA crawler runner.
 *
 * Uses the standard crawler template with the APG|SGA parser.
 * All fetch/parse logic lives in ./lib/apg-sga-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllApgSgaJobs,
  isApgSgaJob,
  isTrustedDomain,
  APG_SGA_KEY,
  APG_SGA_COMPANY_NAME,
} from './lib/apg-sga-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: APG_SGA_KEY,
  companyLabel: APG_SGA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllApgSgaJobs,
  isCompanyJob: isApgSgaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ APG|SGA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
