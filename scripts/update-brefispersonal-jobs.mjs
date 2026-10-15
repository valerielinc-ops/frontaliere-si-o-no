#!/usr/bin/env node
/**
 * Dedicated brefis personal ag crawler runner.
 *
 * Uses the standard crawler template with the brefis personal ag parser.
 * All fetch/parse logic lives in ./lib/brefispersonal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBrefispersonalJobs,
  isBrefispersonalJob,
  isTrustedDomain,
  BREFISPERSONAL_KEY,
  BREFISPERSONAL_COMPANY_NAME,
} from './lib/brefispersonal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BREFISPERSONAL_KEY,
  companyLabel: BREFISPERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBrefispersonalJobs,
  isCompanyJob: isBrefispersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ brefis personal ag crawler failed: ${err?.message || err}`);
  process.exit(1);
});
