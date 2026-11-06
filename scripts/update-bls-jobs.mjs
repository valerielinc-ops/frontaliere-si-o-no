#!/usr/bin/env node
/**
 * Dedicated BLS AG crawler runner.
 *
 * Uses the standard crawler template with the BLS AG parser.
 * All fetch/parse logic lives in ./lib/bls-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBlsJobs,
  isBlsJob,
  isTrustedDomain,
  BLS_KEY,
  BLS_COMPANY_NAME,
} from './lib/bls-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BLS_KEY,
  companyLabel: BLS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBlsJobs,
  isCompanyJob: isBlsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ BLS AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
