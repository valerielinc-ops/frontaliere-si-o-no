#!/usr/bin/env node
/**
 * Dedicated Zuger Kantonsspital crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZugerKantonsspitalJobs,
  isZugerKantonsspitalJob,
  isTrustedDomain,
  ZUGER_KANTONSSPITAL_KEY,
  ZUGER_KANTONSSPITAL_COMPANY_NAME,
} from './lib/zuger-kantonsspital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZUGER_KANTONSSPITAL_KEY,
  companyLabel: ZUGER_KANTONSSPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZugerKantonsspitalJobs,
  isCompanyJob: isZugerKantonsspitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Zuger Kantonsspital crawler failed: ${err?.message || err}`);
  process.exit(1);
});
