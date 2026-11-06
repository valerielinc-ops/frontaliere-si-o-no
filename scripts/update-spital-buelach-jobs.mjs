#!/usr/bin/env node
/**
 * Dedicated Spital Bülach crawler runner.
 *
 * Uses the standard crawler template with the Spital Bülach parser
 * (Prospective.ch v1 medium 1006135).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitalBuelachJobs,
  isSpitalBuelachJob,
  isTrustedDomain,
  SPITAL_BUELACH_KEY,
  SPITAL_BUELACH_COMPANY_NAME,
} from './lib/spital-buelach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SPITAL_BUELACH_KEY,
  companyLabel: SPITAL_BUELACH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSpitalBuelachJobs,
  isCompanyJob: isSpitalBuelachJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Spital Bülach crawler failed: ${err?.message || err}`);
  process.exit(1);
});
