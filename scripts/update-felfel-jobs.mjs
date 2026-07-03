#!/usr/bin/env node
/**
 * Dedicated FELFEL crawler runner.
 *
 * Uses the standard crawler template with the FELFEL parser.
 * All fetch/parse logic lives in ./lib/felfel-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFelfelJobs,
  isFelfelJob,
  isTrustedDomain,
  FELFEL_KEY,
  FELFEL_COMPANY_NAME,
} from './lib/felfel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FELFEL_KEY,
  companyLabel: FELFEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFelfelJobs,
  isCompanyJob: isFelfelJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ FELFEL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
