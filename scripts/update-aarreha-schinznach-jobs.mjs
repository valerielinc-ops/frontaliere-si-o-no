#!/usr/bin/env node
/**
 * Dedicated aarReha Schinznach crawler runner.
 *
 * Uses the standard crawler template with the aarReha Talentsoft parser.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAarrehaSchinznachJobs,
  isAarrehaSchinznachJob,
  isTrustedDomain,
  AARREHA_SCHINZNACH_KEY,
  AARREHA_SCHINZNACH_COMPANY_NAME,
} from './lib/aarreha-schinznach-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AARREHA_SCHINZNACH_KEY,
  companyLabel: AARREHA_SCHINZNACH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAarrehaSchinznachJobs,
  isCompanyJob: isAarrehaSchinznachJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ aarReha Schinznach crawler failed: ${err?.message || err}`);
  process.exit(1);
});
