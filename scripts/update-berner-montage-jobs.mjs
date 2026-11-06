#!/usr/bin/env node
/**
 * Dedicated Montagetechnik BERNER AG crawler runner.
 *
 * Uses the standard crawler template with the Montagetechnik BERNER AG parser.
 * All fetch/parse logic lives in ./lib/berner-montage-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBernerMontageJobs,
  isBernerMontageJob,
  isTrustedDomain,
  BERNER_MONTAGE_KEY,
  BERNER_MONTAGE_COMPANY_NAME,
} from './lib/berner-montage-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BERNER_MONTAGE_KEY,
  companyLabel: BERNER_MONTAGE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBernerMontageJobs,
  isCompanyJob: isBernerMontageJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Montagetechnik BERNER AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
