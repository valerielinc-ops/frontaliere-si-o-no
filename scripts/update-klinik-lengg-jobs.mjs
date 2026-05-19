#!/usr/bin/env node
/**
 * Dedicated Klinik Lengg (Zürich) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikLenggJobs,
  isKlinikLenggJob,
  isTrustedDomain,
  KLINIK_LENGG_KEY,
  KLINIK_LENGG_COMPANY_NAME,
} from './lib/klinik-lengg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_LENGG_KEY,
  companyLabel: KLINIK_LENGG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikLenggJobs,
  isCompanyJob: isKlinikLenggJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Lengg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
