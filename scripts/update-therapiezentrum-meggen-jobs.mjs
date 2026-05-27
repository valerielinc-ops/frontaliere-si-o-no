#!/usr/bin/env node
/**
 * Dedicated Therapiezentrum Meggen (Meggen, LU) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTzmJobs,
  isTzmJob,
  isTrustedDomain,
  TZM_KEY,
  TZM_COMPANY_NAME,
} from './lib/therapiezentrum-meggen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TZM_KEY,
  companyLabel: TZM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTzmJobs,
  isCompanyJob: isTzmJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Therapiezentrum Meggen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
