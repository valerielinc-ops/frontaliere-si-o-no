#!/usr/bin/env node
/**
 * Dedicated Ducksch Anliker AG crawler runner.
 *
 * Uses the standard crawler template with the Ducksch Anliker AG parser.
 * All fetch/parse logic lives in ./lib/ducksch-anliker-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDuckschAnlikerAgJobs,
  isDuckschAnlikerAgJob,
  isTrustedDomain,
  DUCKSCH_ANLIKER_AG_KEY,
  DUCKSCH_ANLIKER_AG_COMPANY_NAME,
} from './lib/ducksch-anliker-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: DUCKSCH_ANLIKER_AG_KEY,
  companyLabel: DUCKSCH_ANLIKER_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllDuckschAnlikerAgJobs,
  isCompanyJob: isDuckschAnlikerAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Ducksch Anliker AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
