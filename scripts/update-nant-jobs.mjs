#!/usr/bin/env node
/**
 * Dedicated Fondation de Nant crawler runner.
 *
 * Uses the standard crawler template with the Fondation de Nant parser.
 * All fetch/parse logic lives in ./lib/nant-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNantJobs,
  isNantJob,
  isTrustedDomain,
  NANT_KEY,
  NANT_COMPANY_NAME,
} from './lib/nant-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NANT_KEY,
  companyLabel: NANT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNantJobs,
  isCompanyJob: isNantJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Fondation de Nant crawler failed: ${err?.message || err}`);
  process.exit(1);
});
