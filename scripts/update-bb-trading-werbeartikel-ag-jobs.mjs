#!/usr/bin/env node
/**
 * Dedicated bb trading werbeartikel ag crawler runner.
 *
 * Uses the standard crawler template with the bb trading werbeartikel ag parser.
 * All fetch/parse logic lives in ./lib/bb-trading-werbeartikel-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBbTradingWerbeartikelAgJobs,
  isBbTradingWerbeartikelAgJob,
  isTrustedDomain,
  BB_TRADING_WERBEARTIKEL_AG_KEY,
  BB_TRADING_WERBEARTIKEL_AG_COMPANY_NAME,
} from './lib/bb-trading-werbeartikel-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BB_TRADING_WERBEARTIKEL_AG_KEY,
  companyLabel: BB_TRADING_WERBEARTIKEL_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBbTradingWerbeartikelAgJobs,
  isCompanyJob: isBbTradingWerbeartikelAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ bb trading werbeartikel ag crawler failed: ${err?.message || err}`);
  process.exit(1);
});
