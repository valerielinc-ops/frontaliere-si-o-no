#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Baden (KSB) crawler runner.
 *
 * Uses the standard crawler template with the KSB parser.
 * All fetch/parse logic lives in ./lib/ksb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsbJobs,
  isKsbJob,
  isTrustedDomain,
  KSB_KEY,
  KSB_COMPANY_NAME,
} from './lib/ksb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSB_KEY,
  companyLabel: KSB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsbJobs,
  isCompanyJob: isKsbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ KSB crawler failed: ${err?.message || err}`);
  process.exit(1);
});
