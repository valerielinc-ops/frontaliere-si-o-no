#!/usr/bin/env node
/**
 * Dedicated SKAN AG crawler runner.
 *
 * Uses the standard crawler template with the SKAN AG parser.
 * All fetch/parse logic lives in ./lib/skan-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSkanComJobs,
  isSkanComJob,
  isTrustedDomain,
  SKAN_COM_KEY,
  SKAN_COM_COMPANY_NAME,
} from './lib/skan-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SKAN_COM_KEY,
  companyLabel: SKAN_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSkanComJobs,
  isCompanyJob: isSkanComJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ SKAN AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
