#!/usr/bin/env node
/**
 * Dedicated mueller-steinmaur crawler runner.
 *
 * Uses the standard crawler template with the mueller-steinmaur parser.
 * All fetch/parse logic lives in ./lib/mueller-steinmaur-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMuellerSteinmaurJobs,
  isMuellerSteinmaurJob,
  isTrustedDomain,
  MUELLER_STEINMAUR_KEY,
  MUELLER_STEINMAUR_COMPANY_NAME,
} from './lib/mueller-steinmaur-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MUELLER_STEINMAUR_KEY,
  companyLabel: MUELLER_STEINMAUR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMuellerSteinmaurJobs,
  isCompanyJob: isMuellerSteinmaurJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ mueller-steinmaur crawler failed: ${err?.message || err}`);
  process.exit(1);
});
