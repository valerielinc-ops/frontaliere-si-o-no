#!/usr/bin/env node
/**
 * Dedicated Forel Klinik crawler runner.
 *
 * Uses the standard crawler template with the Forel Klinik parser
 * (Dualoo — single portal `w1f713hy`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllForelKlinikJobs,
  isForelKlinikJob,
  isTrustedDomain,
  FOREL_KLINIK_KEY,
  FOREL_KLINIK_COMPANY_NAME,
} from './lib/forel-klinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FOREL_KLINIK_KEY,
  companyLabel: FOREL_KLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllForelKlinikJobs,
  isCompanyJob: isForelKlinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Forel Klinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
