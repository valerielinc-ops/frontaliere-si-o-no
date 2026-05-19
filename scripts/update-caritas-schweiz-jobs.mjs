#!/usr/bin/env node
/**
 * Dedicated Caritas Schweiz crawler runner.
 *
 * Uses the standard crawler template with the Caritas Schweiz parser.
 * All fetch/parse logic lives in ./lib/caritas-schweiz-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCaritasSchweizJobs,
  isCaritasSchweizJob,
  isTrustedDomain,
  CARITAS_SCHWEIZ_KEY,
  CARITAS_SCHWEIZ_COMPANY_NAME,
} from './lib/caritas-schweiz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CARITAS_SCHWEIZ_KEY,
  companyLabel: CARITAS_SCHWEIZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCaritasSchweizJobs,
  isCompanyJob: isCaritasSchweizJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Caritas Schweiz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
