#!/usr/bin/env node
/**
 * Dedicated OTTO'S AG crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOttosJobs,
  isOttosJob,
  isTrustedDomain,
  OTTOS_KEY,
  OTTOS_COMPANY_NAME,
} from './lib/ottos-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OTTOS_KEY,
  companyLabel: OTTOS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOttosJobs,
  isCompanyJob: isOttosJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ OTTO'S AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
