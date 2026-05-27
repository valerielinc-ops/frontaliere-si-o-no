#!/usr/bin/env node
/**
 * Dedicated MSC Cargo crawler runner.
 *
 * Uses the standard crawler template with the MSC Cargo parser.
 * All fetch/parse logic lives in ./lib/msc-cargo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMscCargoJobs,
  isMscCargoJob,
  isTrustedDomain,
  MSC_CARGO_KEY,
  MSC_CARGO_COMPANY_NAME,
} from './lib/msc-cargo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MSC_CARGO_KEY,
  companyLabel: MSC_CARGO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMscCargoJobs,
  isCompanyJob: isMscCargoJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ MSC Cargo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
