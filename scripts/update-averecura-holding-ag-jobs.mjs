#!/usr/bin/env node
/**
 * Dedicated averecura holding ag crawler runner.
 *
 * Uses the standard crawler template with the averecura holding ag parser.
 * All fetch/parse logic lives in ./lib/averecura-holding-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAverecuraHoldingAgJobs,
  isAverecuraHoldingAgJob,
  isTrustedDomain,
  AVERECURA_HOLDING_AG_KEY,
  AVERECURA_HOLDING_AG_COMPANY_NAME,
} from './lib/averecura-holding-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AVERECURA_HOLDING_AG_KEY,
  companyLabel: AVERECURA_HOLDING_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAverecuraHoldingAgJobs,
  isCompanyJob: isAverecuraHoldingAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ averecura holding ag crawler failed: ${err?.message || err}`);
  process.exit(1);
});
