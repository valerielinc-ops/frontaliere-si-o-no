#!/usr/bin/env node
/**
 * Dedicated KSML (Kantonaler Stellenmarkt für Lehrerinnen und Lehrer,
 * Kanton Bern) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsmlJobs,
  isKsmlJob,
  isTrustedDomain,
  KSML_KEY,
  KSML_COMPANY_NAME,
} from './lib/ksml-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSML_KEY,
  companyLabel: KSML_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsmlJobs,
  isCompanyJob: isKsmlJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ KSML crawler failed: ${err?.message || err}`);
  process.exit(1);
});
