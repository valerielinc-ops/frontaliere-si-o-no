#!/usr/bin/env node
/**
 * Dedicated Octapharma crawler runner.
 *
 * Uses the standard crawler template with the Octapharma parser.
 * All fetch/parse logic lives in ./lib/octapharma-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOctapharmaJobs,
  isOctapharmaJob,
  isTrustedDomain,
  OCTAPHARMA_KEY,
  OCTAPHARMA_COMPANY_NAME,
} from './lib/octapharma-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OCTAPHARMA_KEY,
  companyLabel: OCTAPHARMA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOctapharmaJobs,
  isCompanyJob: isOctapharmaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Octapharma crawler failed: ${err?.message || err}`);
  process.exit(1);
});
