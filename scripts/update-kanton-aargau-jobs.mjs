#!/usr/bin/env node
/**
 * Dedicated Kanton Aargau crawler runner.
 *
 * Uses the standard crawler template with the Kanton Aargau parser
 * (Umantis ATS, tenant 12705 — see lib/kanton-aargau-job-parser.mjs header
 * for the ATS-discovery correction and pagination details).
 * All fetch/parse logic lives in ./lib/kanton-aargau-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonAargauJobs,
  isKantonAargauJob,
  isTrustedDomain,
  KANTON_AARGAU_KEY,
  KANTON_AARGAU_COMPANY_NAME,
} from './lib/kanton-aargau-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KANTON_AARGAU_KEY,
  companyLabel: KANTON_AARGAU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKantonAargauJobs,
  isCompanyJob: isKantonAargauJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kanton Aargau crawler failed: ${err?.message || err}`);
  process.exit(1);
});
