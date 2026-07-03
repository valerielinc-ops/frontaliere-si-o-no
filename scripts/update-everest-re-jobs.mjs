#!/usr/bin/env node
/**
 * Dedicated Everest Re crawler runner.
 *
 * Uses the standard crawler template with the Everest Re parser.
 * All fetch/parse logic lives in ./lib/everest-re-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEverestReJobs,
  isEverestReJob,
  isTrustedDomain,
  EVEREST_RE_KEY,
  EVEREST_RE_COMPANY_NAME,
} from './lib/everest-re-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EVEREST_RE_KEY,
  companyLabel: EVEREST_RE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEverestReJobs,
  isCompanyJob: isEverestReJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Everest Re crawler failed: ${err?.message || err}`);
  process.exit(1);
});
