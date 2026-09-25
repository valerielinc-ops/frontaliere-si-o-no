#!/usr/bin/env node
/**
 * Dedicated Honegger AG crawler runner.
 *
 * Uses the standard crawler template with the Honegger parser.
 * All fetch/parse logic lives in ./lib/honegger-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHoneggerJobs,
  isHoneggerJob,
  isTrustedDomain,
  HONEGGER_KEY,
  HONEGGER_COMPANY_NAME,
} from './lib/honegger-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HONEGGER_KEY,
  companyLabel: HONEGGER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHoneggerJobs,
  isCompanyJob: isHoneggerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Honegger AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
