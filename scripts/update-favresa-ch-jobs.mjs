#!/usr/bin/env node
/**
 * Dedicated Favre SA crawler runner.
 *
 * Uses the standard crawler template with the Favre SA parser.
 * All fetch/parse logic lives in ./lib/favresa-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFavresaChJobs,
  isFavresaChJob,
  isTrustedDomain,
  FAVRESA_CH_KEY,
  FAVRESA_CH_COMPANY_NAME,
} from './lib/favresa-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FAVRESA_CH_KEY,
  companyLabel: FAVRESA_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFavresaChJobs,
  isCompanyJob: isFavresaChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Favre SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
