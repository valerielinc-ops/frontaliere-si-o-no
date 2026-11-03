#!/usr/bin/env node
/**
 * Dedicated Engadin St. Moritz Mountains AG crawler runner.
 *
 * Uses the standard crawler template with the Engadin St. Moritz Mountains AG parser.
 * All fetch/parse logic lives in ./lib/mountains-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMountainsChJobs,
  isMountainsChJob,
  isTrustedDomain,
  MOUNTAINS_CH_KEY,
  MOUNTAINS_CH_COMPANY_NAME,
} from './lib/mountains-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MOUNTAINS_CH_KEY,
  companyLabel: MOUNTAINS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMountainsChJobs,
  isCompanyJob: isMountainsChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Engadin St. Moritz Mountains AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
