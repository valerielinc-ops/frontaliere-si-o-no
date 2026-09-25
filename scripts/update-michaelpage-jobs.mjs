#!/usr/bin/env node
/**
 * Dedicated Michael Page crawler runner.
 *
 * Uses the standard crawler template with the Michael Page parser.
 * All fetch/parse logic lives in ./lib/michaelpage-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMichaelpageJobs,
  isMichaelpageJob,
  isTrustedDomain,
  MICHAELPAGE_KEY,
  MICHAELPAGE_COMPANY_NAME,
} from './lib/michaelpage-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MICHAELPAGE_KEY,
  companyLabel: MICHAELPAGE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMichaelpageJobs,
  isCompanyJob: isMichaelpageJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Michael Page crawler failed: ${err?.message || err}`);
  process.exit(1);
});
