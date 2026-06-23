#!/usr/bin/env node
/**
 * Dedicated Galderma crawler runner.
 *
 * Uses the standard crawler template with the Galderma parser.
 * All fetch/parse logic lives in ./lib/galderma-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGaldermaJobs,
  isGaldermaJob,
  isTrustedDomain,
  GALDERMA_KEY,
  GALDERMA_COMPANY_NAME,
} from './lib/galderma-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GALDERMA_KEY,
  companyLabel: GALDERMA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGaldermaJobs,
  isCompanyJob: isGaldermaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Galderma crawler failed: ${err?.message || err}`);
  process.exit(1);
});
