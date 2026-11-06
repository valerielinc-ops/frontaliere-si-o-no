#!/usr/bin/env node
/**
 * Dedicated Marriott International crawler runner.
 *
 * Uses the standard crawler template with the Marriott International parser.
 * All fetch/parse logic lives in ./lib/marriott-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMarriottJobs,
  isMarriottJob,
  isTrustedDomain,
  MARRIOTT_KEY,
  MARRIOTT_COMPANY_NAME,
} from './lib/marriott-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MARRIOTT_KEY,
  companyLabel: MARRIOTT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMarriottJobs,
  isCompanyJob: isMarriottJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Marriott International crawler failed: ${err?.message || err}`);
  process.exit(1);
});
