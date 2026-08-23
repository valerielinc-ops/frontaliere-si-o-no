#!/usr/bin/env node
/**
 * Dedicated Bürgenstock Collection crawler runner.
 *
 * Uses the standard crawler template with the Bürgenstock Collection parser.
 * All fetch/parse logic lives in ./lib/burgenstock-collection-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBurgenstockCollectionJobs,
  isBurgenstockCollectionJob,
  isTrustedDomain,
  BURGENSTOCK_COLLECTION_KEY,
  BURGENSTOCK_COLLECTION_COMPANY_NAME,
} from './lib/burgenstock-collection-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BURGENSTOCK_COLLECTION_KEY,
  companyLabel: BURGENSTOCK_COLLECTION_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBurgenstockCollectionJobs,
  isCompanyJob: isBurgenstockCollectionJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bürgenstock Collection crawler failed: ${err?.message || err}`);
  process.exit(1);
});
