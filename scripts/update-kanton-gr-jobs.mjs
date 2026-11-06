#!/usr/bin/env node
/**
 * Dedicated Kantonale Verwaltung Graubünden crawler runner.
 *
 * Uses the standard crawler template with the Kantonale Verwaltung Graubünden parser.
 * All fetch/parse logic lives in ./lib/kanton-gr-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonGrJobs,
  isKantonGrJob,
  isTrustedDomain,
  KANTON_GR_KEY,
  KANTON_GR_COMPANY_NAME,
} from './lib/kanton-gr-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KANTON_GR_KEY,
  companyLabel: KANTON_GR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKantonGrJobs,
  isCompanyJob: isKantonGrJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonale Verwaltung Graubünden crawler failed: ${err?.message || err}`);
  process.exit(1);
});
