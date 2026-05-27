#!/usr/bin/env node
/**
 * Dedicated Schulthess Klinik crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSchulthessKlinikJobs,
  isSchulthessKlinikJob,
  isTrustedDomain,
  SCHULTHESS_KLINIK_KEY,
  SCHULTHESS_KLINIK_COMPANY_NAME,
} from './lib/schulthess-klinik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SCHULTHESS_KLINIK_KEY,
  companyLabel: SCHULTHESS_KLINIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSchulthessKlinikJobs,
  isCompanyJob: isSchulthessKlinikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Schulthess Klinik crawler failed: ${err?.message || err}`);
  process.exit(1);
});
