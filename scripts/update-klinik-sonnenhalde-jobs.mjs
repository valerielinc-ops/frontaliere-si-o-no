#!/usr/bin/env node
/**
 * Dedicated Klinik Sonnenhalde Riehen crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSonnenhaldeJobs,
  isKlinikSonnenhaldeJob,
  isTrustedDomain,
  KLINIK_SONNENHALDE_KEY,
  KLINIK_SONNENHALDE_COMPANY_NAME,
} from './lib/klinik-sonnenhalde-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SONNENHALDE_KEY,
  companyLabel: KLINIK_SONNENHALDE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSonnenhaldeJobs,
  isCompanyJob: isKlinikSonnenhaldeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Sonnenhalde crawler failed: ${err?.message || err}`);
  process.exit(1);
});
