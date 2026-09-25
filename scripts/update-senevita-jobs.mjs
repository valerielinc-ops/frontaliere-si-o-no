#!/usr/bin/env node
/**
 * Dedicated Senevita crawler runner.
 *
 * Uses the standard crawler template with the Senevita parser.
 * All fetch/parse logic lives in ./lib/senevita-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSenevitaJobs,
  isSenevitaJob,
  isTrustedDomain,
  SENEVITA_KEY,
  SENEVITA_COMPANY_NAME,
} from './lib/senevita-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SENEVITA_KEY,
  companyLabel: SENEVITA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSenevitaJobs,
  isCompanyJob: isSenevitaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Senevita crawler failed: ${err?.message || err}`);
  process.exit(1);
});
