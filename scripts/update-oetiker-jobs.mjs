#!/usr/bin/env node
/**
 * Dedicated Oetiker crawler runner.
 *
 * Uses the standard crawler template with the Oetiker parser.
 * All fetch/parse logic lives in ./lib/oetiker-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOetikerJobs,
  isOetikerJob,
  isTrustedDomain,
  OETIKER_KEY,
  OETIKER_COMPANY_NAME,
} from './lib/oetiker-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OETIKER_KEY,
  companyLabel: OETIKER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOetikerJobs,
  isCompanyJob: isOetikerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Oetiker crawler failed: ${err?.message || err}`);
  process.exit(1);
});
