#!/usr/bin/env node
/**
 * Dedicated Huber+Suhner AG crawler runner.
 *
 * Uses the standard crawler template with the Huber+Suhner AG parser.
 * All fetch/parse logic lives in ./lib/huber-suhner-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHuberSuhnerJobs,
  isHuberSuhnerJob,
  isTrustedDomain,
  HUBER_SUHNER_KEY,
  HUBER_SUHNER_COMPANY_NAME,
} from './lib/huber-suhner-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HUBER_SUHNER_KEY,
  companyLabel: HUBER_SUHNER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHuberSuhnerJobs,
  isCompanyJob: isHuberSuhnerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Huber+Suhner AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
