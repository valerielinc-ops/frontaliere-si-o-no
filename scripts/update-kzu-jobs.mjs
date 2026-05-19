#!/usr/bin/env node
/**
 * Dedicated KZU (Kompetenzzentrum Pflege und Gesundheit) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKzuJobs,
  isKzuJob,
  isTrustedDomain,
  KZU_KEY,
  KZU_COMPANY_NAME,
} from './lib/kzu-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KZU_KEY,
  companyLabel: KZU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKzuJobs,
  isCompanyJob: isKzuJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ KZU crawler failed: ${err?.message || err}`);
  process.exit(1);
});
