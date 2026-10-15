#!/usr/bin/env node
/**
 * Dedicated Klinik SGM Langenthal crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSgmJobs,
  isKlinikSgmJob,
  isTrustedDomain,
  KLINIK_SGM_KEY,
  KLINIK_SGM_COMPANY_NAME,
} from './lib/klinik-sgm-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SGM_KEY,
  companyLabel: KLINIK_SGM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSgmJobs,
  isCompanyJob: isKlinikSgmJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik SGM crawler failed: ${err?.message || err}`);
  process.exit(1);
});
