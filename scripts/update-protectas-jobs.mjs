#!/usr/bin/env node
/**
 * Dedicated Protectas SA crawler runner.
 *
 * Uses the standard crawler template with the Protectas SA parser.
 * All fetch/parse logic lives in ./lib/protectas-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllProtectasJobs,
  isProtectasJob,
  isTrustedDomain,
  PROTECTAS_KEY,
  PROTECTAS_COMPANY_NAME,
} from './lib/protectas-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PROTECTAS_KEY,
  companyLabel: PROTECTAS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllProtectasJobs,
  isCompanyJob: isProtectasJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Protectas SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
