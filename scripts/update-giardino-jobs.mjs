#!/usr/bin/env node
/**
 * Dedicated Giardino Group crawler runner.
 *
 * Uses the standard crawler template with the Giardino Group parser.
 * All fetch/parse logic lives in ./lib/giardino-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGiardinoJobs,
  isGiardinoJob,
  isTrustedDomain,
  GIARDINO_KEY,
  GIARDINO_COMPANY_NAME,
} from './lib/giardino-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GIARDINO_KEY,
  companyLabel: GIARDINO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGiardinoJobs,
  isCompanyJob: isGiardinoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Giardino Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
