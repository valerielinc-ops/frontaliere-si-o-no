#!/usr/bin/env node
/**
 * Dedicated Global Sana crawler runner.
 *
 * Uses the standard crawler template with the Global Sana parser.
 * All fetch/parse logic lives in ./lib/ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChJobs,
  isChJob,
  isTrustedDomain,
  CH_KEY,
  CH_COMPANY_NAME,
} from './lib/ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CH_KEY,
  companyLabel: CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChJobs,
  isCompanyJob: isChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Global Sana crawler failed: ${err?.message || err}`);
  process.exit(1);
});
