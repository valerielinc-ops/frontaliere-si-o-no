#!/usr/bin/env node
/**
 * Dedicated Restaurant & Hôtel Vatel crawler runner.
 *
 * Uses the standard crawler template with the Restaurant & Hôtel Vatel parser.
 * All fetch/parse logic lives in ./lib/vatel-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVatelChJobs,
  isVatelChJob,
  isTrustedDomain,
  VATEL_CH_KEY,
  VATEL_CH_COMPANY_NAME,
} from './lib/vatel-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VATEL_CH_KEY,
  companyLabel: VATEL_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVatelChJobs,
  isCompanyJob: isVatelChJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Restaurant & Hôtel Vatel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
