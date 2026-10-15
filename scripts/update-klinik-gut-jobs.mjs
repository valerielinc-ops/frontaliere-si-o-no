#!/usr/bin/env node
/**
 * Dedicated Klinik Gut AG crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikGutJobs,
  isKlinikGutJob,
  isTrustedDomain,
  KLINIK_GUT_KEY,
  KLINIK_GUT_COMPANY_NAME,
} from './lib/klinik-gut-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_GUT_KEY,
  companyLabel: KLINIK_GUT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikGutJobs,
  isCompanyJob: isKlinikGutJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Gut crawler failed: ${err?.message || err}`);
  process.exit(1);
});
