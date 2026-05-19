#!/usr/bin/env node
/**
 * Dedicated Uroviva crawler runner.
 *
 * Uses the standard crawler template with the Uroviva parser
 * (Dualoo — single portal `nthmjmb4`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUrovivaJobs,
  isUrovivaJob,
  isTrustedDomain,
  UROVIVA_KEY,
  UROVIVA_COMPANY_NAME,
} from './lib/uroviva-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UROVIVA_KEY,
  companyLabel: UROVIVA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUrovivaJobs,
  isCompanyJob: isUrovivaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Uroviva crawler failed: ${err?.message || err}`);
  process.exit(1);
});
