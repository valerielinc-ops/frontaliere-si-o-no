#!/usr/bin/env node
/**
 * Dedicated Arxada crawler runner.
 *
 * Uses the standard crawler template with the Arxada parser.
 * All fetch/parse logic lives in ./lib/arxada-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllArxadaJobs,
  isArxadaJob,
  isTrustedDomain,
  ARXADA_KEY,
  ARXADA_COMPANY_NAME,
} from './lib/arxada-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ARXADA_KEY,
  companyLabel: ARXADA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllArxadaJobs,
  isCompanyJob: isArxadaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Arxada crawler failed: ${err?.message || err}`);
  process.exit(1);
});
