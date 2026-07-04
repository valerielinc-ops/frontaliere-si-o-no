#!/usr/bin/env node
/**
 * Dedicated Josef Müller Gemüse AG crawler runner.
 *
 * Uses the standard crawler template with the Josef Müller parser.
 * All fetch/parse logic lives in ./lib/josef-mueller-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllJosefMuellerJobs,
  isJosefMuellerJob,
  isTrustedDomain,
  JOSEF_MUELLER_KEY,
  JOSEF_MUELLER_COMPANY_NAME,
} from './lib/josef-mueller-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: JOSEF_MUELLER_KEY,
  companyLabel: JOSEF_MUELLER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllJosefMuellerJobs,
  isCompanyJob: isJosefMuellerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Josef Müller Gemüse AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
