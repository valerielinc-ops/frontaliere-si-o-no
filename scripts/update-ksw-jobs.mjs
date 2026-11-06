#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Winterthur (KSW) crawler runner.
 *
 * Uses the standard crawler template with the Kantonsspital Winterthur (KSW) parser.
 * All fetch/parse logic lives in ./lib/ksw-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKswJobs,
  isKswJob,
  isTrustedDomain,
  KSW_KEY,
  KSW_COMPANY_NAME,
} from './lib/ksw-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSW_KEY,
  companyLabel: KSW_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKswJobs,
  isCompanyJob: isKswJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital Winterthur (KSW) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
