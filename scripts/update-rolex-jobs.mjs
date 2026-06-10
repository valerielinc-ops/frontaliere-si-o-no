#!/usr/bin/env node
/**
 * Dedicated Rolex crawler runner.
 *
 * Uses the standard crawler template with the Rolex parser.
 * All fetch/parse logic lives in ./lib/rolex-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRolexJobs,
  isRolexJob,
  isTrustedDomain,
  ROLEX_KEY,
  ROLEX_COMPANY_NAME,
} from './lib/rolex-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ROLEX_KEY,
  companyLabel: ROLEX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRolexJobs,
  isCompanyJob: isRolexJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Rolex crawler failed: ${err?.message || err}`);
  process.exit(1);
});
