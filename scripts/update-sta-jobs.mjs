#!/usr/bin/env node
/**
 * Dedicated STA Personal AG crawler runner.
 *
 * Uses the standard crawler template with the STA Personal AG parser.
 * All fetch/parse logic lives in ./lib/sta-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStaJobs,
  isStaJob,
  isTrustedDomain,
  STA_KEY,
  STA_COMPANY_NAME,
} from './lib/sta-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STA_KEY,
  companyLabel: STA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStaJobs,
  isCompanyJob: isStaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ STA Personal AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
