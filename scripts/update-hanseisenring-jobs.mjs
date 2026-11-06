#!/usr/bin/env node
/**
 * Dedicated Hans Eisenring AG crawler runner.
 *
 * Uses the standard crawler template with the Hans Eisenring AG parser.
 * All fetch/parse logic lives in ./lib/hanseisenring-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHanseisenringJobs,
  isHanseisenringJob,
  isTrustedDomain,
  HANSEISENRING_KEY,
  HANSEISENRING_COMPANY_NAME,
} from './lib/hanseisenring-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HANSEISENRING_KEY,
  companyLabel: HANSEISENRING_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHanseisenringJobs,
  isCompanyJob: isHanseisenringJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Hans Eisenring AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
