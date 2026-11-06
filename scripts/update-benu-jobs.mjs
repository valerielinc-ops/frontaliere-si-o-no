#!/usr/bin/env node
/**
 * Dedicated benu crawler runner.
 *
 * Uses the standard crawler template with the benu parser.
 * All fetch/parse logic lives in ./lib/benu-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBenuJobs,
  isBenuJob,
  isTrustedDomain,
  BENU_KEY,
  BENU_COMPANY_NAME,
} from './lib/benu-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BENU_KEY,
  companyLabel: BENU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBenuJobs,
  isCompanyJob: isBenuJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ benu crawler failed: ${err?.message || err}`);
  process.exit(1);
});
