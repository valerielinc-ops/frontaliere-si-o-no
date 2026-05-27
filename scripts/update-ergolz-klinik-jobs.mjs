#!/usr/bin/env node
/**
 * Dedicated Ergolz Klinik crawler runner.
 *
 * Uses the standard crawler template with the Ergolz Klinik parser.
 * All fetch/parse logic lives in ./lib/ergolz-klinik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllErgolzKlinikJobs,
  isErgolzKlinikJob,
  isTrustedDomain,
  ERGOLZ_KLINIK_KEY,
  ERGOLZ_KLINIK_COMPANY_NAME,
} from './lib/ergolz-klinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ERGOLZ_KLINIK_KEY,
  companyLabel: ERGOLZ_KLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllErgolzKlinikJobs,
  isCompanyJob: isErgolzKlinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Ergolz Klinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
