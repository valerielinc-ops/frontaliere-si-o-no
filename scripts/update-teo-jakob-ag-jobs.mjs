#!/usr/bin/env node
/**
 * Dedicated Teo Jakob AG crawler runner.
 *
 * Uses the standard crawler template with the Teo Jakob AG parser.
 * All fetch/parse logic lives in ./lib/teo-jakob-ag-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTeoJakobAgJobs,
  isTeoJakobAgJob,
  isTrustedDomain,
  TEO_JAKOB_AG_KEY,
  TEO_JAKOB_AG_COMPANY_NAME,
} from './lib/teo-jakob-ag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TEO_JAKOB_AG_KEY,
  companyLabel: TEO_JAKOB_AG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTeoJakobAgJobs,
  isCompanyJob: isTeoJakobAgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Teo Jakob AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
