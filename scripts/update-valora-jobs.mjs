#!/usr/bin/env node
/**
 * Dedicated Valora Group crawler runner.
 *
 * Uses the standard crawler template with the Valora Group parser.
 * All fetch/parse logic lives in ./lib/valora-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllValoraJobs,
  isValoraJob,
  isTrustedDomain,
  VALORA_KEY,
  VALORA_COMPANY_NAME,
} from './lib/valora-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VALORA_KEY,
  companyLabel: VALORA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllValoraJobs,
  isCompanyJob: isValoraJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Valora Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
