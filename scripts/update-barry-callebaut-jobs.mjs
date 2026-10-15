#!/usr/bin/env node
/**
 * Dedicated Barry Callebaut crawler runner.
 *
 * Uses the standard crawler template with the Barry Callebaut parser.
 * All fetch/parse logic lives in ./lib/barry-callebaut-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBarryCallebautJobs,
  isBarryCallebautJob,
  isTrustedDomain,
  BARRY_CALLEBAUT_KEY,
  BARRY_CALLEBAUT_COMPANY_NAME,
} from './lib/barry-callebaut-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BARRY_CALLEBAUT_KEY,
  companyLabel: BARRY_CALLEBAUT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBarryCallebautJobs,
  isCompanyJob: isBarryCallebautJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Barry Callebaut crawler failed: ${err?.message || err}`);
  process.exit(1);
});
