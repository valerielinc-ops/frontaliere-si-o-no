#!/usr/bin/env node
/**
 * Dedicated SWICA crawler runner.
 *
 * Uses the standard crawler template with the SWICA parser.
 * All fetch/parse logic lives in ./lib/swica-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSwicaJobs,
  isSwicaJob,
  isTrustedDomain,
  SWICA_KEY,
  SWICA_COMPANY_NAME,
} from './lib/swica-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SWICA_KEY,
  companyLabel: SWICA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSwicaJobs,
  isCompanyJob: isSwicaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SWICA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
