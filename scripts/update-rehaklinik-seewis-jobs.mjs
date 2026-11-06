#!/usr/bin/env node
/**
 * Dedicated Kurhaus crawler runner.
 *
 * Uses the standard crawler template with the Kurhaus parser.
 * All fetch/parse logic lives in ./lib/rehaklinik-seewis-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehaklinikSeewisJobs,
  isRehaklinikSeewisJob,
  isTrustedDomain,
  REHAKLINIK_SEEWIS_KEY,
  REHAKLINIK_SEEWIS_COMPANY_NAME,
} from './lib/rehaklinik-seewis-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: REHAKLINIK_SEEWIS_KEY,
  companyLabel: REHAKLINIK_SEEWIS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRehaklinikSeewisJobs,
  isCompanyJob: isRehaklinikSeewisJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kurhaus crawler failed: ${err?.message || err}`);
  process.exit(1);
});
