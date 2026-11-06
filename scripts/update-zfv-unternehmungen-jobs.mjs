#!/usr/bin/env node
/**
 * Dedicated ZFV-Unternehmungen crawler runner.
 *
 * Uses the standard crawler template with the ZFV-Unternehmungen parser.
 * All fetch/parse logic lives in ./lib/zfv-unternehmungen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZfvUnternehmungenJobs,
  isZfvUnternehmungenJob,
  isTrustedDomain,
  ZFV_UNTERNEHMUNGEN_KEY,
  ZFV_UNTERNEHMUNGEN_COMPANY_NAME,
} from './lib/zfv-unternehmungen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZFV_UNTERNEHMUNGEN_KEY,
  companyLabel: ZFV_UNTERNEHMUNGEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZfvUnternehmungenJobs,
  isCompanyJob: isZfvUnternehmungenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ZFV-Unternehmungen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
