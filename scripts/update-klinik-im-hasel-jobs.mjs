#!/usr/bin/env node
/**
 * Dedicated Klinik im Hasel crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikImHaselJobs,
  isKlinikImHaselJob,
  isTrustedDomain,
  KLINIK_IM_HASEL_KEY,
  KLINIK_IM_HASEL_COMPANY_NAME,
} from './lib/klinik-im-hasel-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_IM_HASEL_KEY,
  companyLabel: KLINIK_IM_HASEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikImHaselJobs,
  isCompanyJob: isKlinikImHaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik im Hasel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
