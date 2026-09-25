#!/usr/bin/env node
/**
 * Dedicated Kiabi Suisse crawler runner.
 *
 * Uses the standard crawler template with the Kiabi Suisse parser.
 * All fetch/parse logic lives in ./lib/kiabi-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKiabiJobs,
  isKiabiJob,
  isTrustedDomain,
  KIABI_KEY,
  KIABI_COMPANY_NAME,
} from './lib/kiabi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KIABI_KEY,
  companyLabel: KIABI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKiabiJobs,
  isCompanyJob: isKiabiJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Kiabi Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
