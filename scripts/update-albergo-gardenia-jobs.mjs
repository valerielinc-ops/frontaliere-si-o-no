#!/usr/bin/env node
/**
 * Dedicated Albergo Gardenia crawler runner.
 *
 * Uses the standard crawler template with the Albergo Gardenia parser.
 * All fetch/parse logic lives in ./lib/albergo-gardenia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAlbergoGardeniaJobs,
  assertCompleteAlbergoGardeniaSnapshot,
  isAlbergoGardeniaJob,
  isTrustedDomain,
  ALBERGO_GARDENIA_KEY,
  ALBERGO_GARDENIA_COMPANY_NAME,
} from './lib/albergo-gardenia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ALBERGO_GARDENIA_KEY,
  companyLabel: ALBERGO_GARDENIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAlbergoGardeniaJobs,
  isCompanyJob: isAlbergoGardeniaJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  validateAuthoritativeSnapshot: assertCompleteAlbergoGardeniaSnapshot,
  allowAuthoritativeEmptySnapshot: true,
}).catch((err) => {
  console.error(`❌ Albergo Gardenia crawler failed: ${err?.message || err}`);
  process.exit(1);
});
