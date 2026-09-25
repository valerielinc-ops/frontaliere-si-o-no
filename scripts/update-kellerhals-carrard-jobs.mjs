#!/usr/bin/env node
/**
 * Dedicated Kellerhals Carrard crawler runner.
 *
 * Uses the standard crawler template with the Kellerhals Carrard parser.
 * All fetch/parse logic lives in ./lib/kellerhals-carrard-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKellerhalsCarrardJobs,
  isKellerhalsCarrardJob,
  isTrustedDomain,
  KELLERHALS_CARRARD_KEY,
  KELLERHALS_CARRARD_COMPANY_NAME,
} from './lib/kellerhals-carrard-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KELLERHALS_CARRARD_KEY,
  companyLabel: KELLERHALS_CARRARD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKellerhalsCarrardJobs,
  isCompanyJob: isKellerhalsCarrardJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kellerhals Carrard crawler failed: ${err?.message || err}`);
  process.exit(1);
});
