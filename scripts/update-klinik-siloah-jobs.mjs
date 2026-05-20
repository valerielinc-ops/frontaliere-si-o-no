#!/usr/bin/env node
/**
 * Dedicated Privatklinik Siloah (SMN PKS, Gümligen BE) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSiloahJobs,
  isKlinikSiloahJob,
  isTrustedDomain,
  KLINIK_SILOAH_KEY,
  KLINIK_SILOAH_COMPANY_NAME,
} from './lib/klinik-siloah-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SILOAH_KEY,
  companyLabel: KLINIK_SILOAH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSiloahJobs,
  isCompanyJob: isKlinikSiloahJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Siloah crawler failed: ${err?.message || err}`);
  process.exit(1);
});
