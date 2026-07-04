#!/usr/bin/env node
/**
 * Dedicated Orell Füssli Thalia crawler runner.
 *
 * Uses the standard crawler template with the Orell Füssli Thalia parser.
 * All fetch/parse logic lives in ./lib/orell-fuessli-thalia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOrellFuessliThaliaJobs,
  isOrellFuessliThaliaJob,
  isTrustedDomain,
  ORELL_FUESSLI_THALIA_KEY,
  ORELL_FUESSLI_THALIA_COMPANY_NAME,
} from './lib/orell-fuessli-thalia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ORELL_FUESSLI_THALIA_KEY,
  companyLabel: ORELL_FUESSLI_THALIA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOrellFuessliThaliaJobs,
  isCompanyJob: isOrellFuessliThaliaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Orell Füssli Thalia crawler failed: ${err?.message || err}`);
  process.exit(1);
});
