#!/usr/bin/env node
/**
 * Dedicated Reha Andeer (Andeer, GR) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehaAndeerJobs,
  isRehaAndeerJob,
  isTrustedDomain,
  REHA_ANDEER_KEY,
  REHA_ANDEER_COMPANY_NAME,
} from './lib/reha-andeer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: REHA_ANDEER_KEY,
  companyLabel: REHA_ANDEER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRehaAndeerJobs,
  isCompanyJob: isRehaAndeerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Reha Andeer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
