#!/usr/bin/env node
/**
 * Dedicated Klinik Schönberg (Gunten, BE) crawler runner — Jobalino.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSchoenbergJobs,
  isKlinikSchoenbergJob,
  isTrustedDomain,
  KLINIK_SCHOENBERG_KEY,
  KLINIK_SCHOENBERG_COMPANY_NAME,
} from './lib/klinik-schoenberg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SCHOENBERG_KEY,
  companyLabel: KLINIK_SCHOENBERG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSchoenbergJobs,
  isCompanyJob: isKlinikSchoenbergJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Schönberg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
