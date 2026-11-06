#!/usr/bin/env node
/**
 * Dedicated Luzerner Kantonsspital (LUKS) crawler runner.
 *
 * Uses the standard crawler template with the Luzerner Kantonsspital (LUKS) parser.
 * All fetch/parse logic lives in ./lib/luks-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLuksJobs,
  isLuksJob,
  isTrustedDomain,
  LUKS_KEY,
  LUKS_COMPANY_NAME,
} from './lib/luks-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LUKS_KEY,
  companyLabel: LUKS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLuksJobs,
  isCompanyJob: isLuksJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Luzerner Kantonsspital (LUKS) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
