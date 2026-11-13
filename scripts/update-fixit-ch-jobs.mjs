#!/usr/bin/env node
/**
 * Dedicated Fixit AG crawler runner.
 *
 * Uses the standard crawler template with the Fixit AG parser.
 * All fetch/parse logic lives in ./lib/fixit-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFixitChJobs,
  isFixitChJob,
  isTrustedDomain,
  FIXIT_CH_KEY,
  FIXIT_CH_COMPANY_NAME,
} from './lib/fixit-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FIXIT_CH_KEY,
  companyLabel: FIXIT_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFixitChJobs,
  isCompanyJob: isFixitChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Fixit AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
