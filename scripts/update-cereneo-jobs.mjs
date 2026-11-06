#!/usr/bin/env node
/**
 * Dedicated Cereneo crawler runner.
 *
 * Uses the standard crawler template with the Cereneo parser
 * (Dualoo — single portal `muy5swcr`, foreign-country jobs filtered out).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCereneoJobs,
  isCereneoJob,
  isTrustedDomain,
  CERENEO_KEY,
  CERENEO_COMPANY_NAME,
} from './lib/cereneo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CERENEO_KEY,
  companyLabel: CERENEO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCereneoJobs,
  isCompanyJob: isCereneoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Cereneo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
