#!/usr/bin/env node
/**
 * Dedicated Kanton St. Gallen crawler runner.
 *
 * Uses the standard crawler template with the Kanton St. Gallen parser
 * (Umantis ATS, tenant 2800 — see lib/kanton-st-gallen-job-parser.mjs header
 * for the ATS-discovery correction and detail-page layout notes).
 * All fetch/parse logic lives in ./lib/kanton-st-gallen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonStGallenJobs,
  isKantonStGallenJob,
  isTrustedDomain,
  KANTON_ST_GALLEN_KEY,
  KANTON_ST_GALLEN_COMPANY_NAME,
} from './lib/kanton-st-gallen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KANTON_ST_GALLEN_KEY,
  companyLabel: KANTON_ST_GALLEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKantonStGallenJobs,
  isCompanyJob: isKantonStGallenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kanton St. Gallen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
