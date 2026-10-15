#!/usr/bin/env node
/**
 * Dedicated Sulzer crawler runner.
 *
 * Uses the standard crawler template with the Sulzer parser.
 * All fetch/parse logic lives in ./lib/sulzer-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSulzerJobs,
  isSulzerJob,
  isTrustedDomain,
  SULZER_KEY,
  SULZER_COMPANY_NAME,
} from './lib/sulzer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SULZER_KEY,
  companyLabel: SULZER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSulzerJobs,
  isCompanyJob: isSulzerJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Sulzer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
