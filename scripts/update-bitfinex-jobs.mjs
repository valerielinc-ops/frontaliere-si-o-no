#!/usr/bin/env node
/**
 * Dedicated Bitfinex crawler runner.
 *
 * Uses the standard crawler template with the Bitfinex parser.
 * All fetch/parse logic lives in ./lib/bitfinex-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBitfinexJobs,
  isBitfinexJob,
  isTrustedDomain,
  BITFINEX_KEY,
  BITFINEX_COMPANY_NAME,
} from './lib/bitfinex-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BITFINEX_KEY,
  companyLabel: BITFINEX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBitfinexJobs,
  isCompanyJob: isBitfinexJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Bitfinex crawler failed: ${err?.message || err}`);
  process.exit(1);
});
