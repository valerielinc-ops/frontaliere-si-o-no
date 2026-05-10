#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Aarau (KSA) crawler runner.
 *
 * Uses the standard crawler template with the Kantonsspital Aarau (KSA) parser.
 * All fetch/parse logic lives in ./lib/ksa-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsaJobs,
  isKsaJob,
  isTrustedDomain,
  KSA_KEY,
  KSA_COMPANY_NAME,
} from './lib/ksa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSA_KEY,
  companyLabel: KSA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsaJobs,
  isCompanyJob: isKsaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital Aarau (KSA) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
