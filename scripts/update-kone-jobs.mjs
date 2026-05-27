#!/usr/bin/env node
/**
 * Dedicated KONE crawler runner.
 *
 * Uses the standard crawler template with the KONE parser.
 * All fetch/parse logic lives in ./lib/kone-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKoneJobs,
  isKoneJob,
  isTrustedDomain,
  KONE_KEY,
  KONE_COMPANY_NAME,
} from './lib/kone-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KONE_KEY,
  companyLabel: KONE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKoneJobs,
  isCompanyJob: isKoneJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ KONE crawler failed: ${err?.message || err}`);
  process.exit(1);
});
