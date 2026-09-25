#!/usr/bin/env node
/**
 * Dedicated PDAG (Psychiatrische Dienste Aargau) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPdagJobs,
  isPdagJob,
  isTrustedDomain,
  PDAG_KEY,
  PDAG_COMPANY_NAME,
} from './lib/pdag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PDAG_KEY,
  companyLabel: PDAG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPdagJobs,
  isCompanyJob: isPdagJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ PDAG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
