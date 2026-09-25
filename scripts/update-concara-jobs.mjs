#!/usr/bin/env node
/**
 * Dedicated Concara (Domicil & Spitex Bern) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllConcaraJobs,
  isConcaraJob,
  isTrustedDomain,
  CONCARA_KEY,
  CONCARA_COMPANY_NAME,
} from './lib/concara-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CONCARA_KEY,
  companyLabel: CONCARA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllConcaraJobs,
  isCompanyJob: isConcaraJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Concara crawler failed: ${err?.message || err}`);
  process.exit(1);
});
