#!/usr/bin/env node
/**
 * Dedicated SIX Group crawler runner.
 *
 * Uses the standard crawler template with the SIX Group parser.
 * All fetch/parse logic lives in ./lib/six-group-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSixGroupJobs,
  isSixGroupJob,
  isTrustedDomain,
  SIX_GROUP_KEY,
  SIX_GROUP_COMPANY_NAME,
} from './lib/six-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SIX_GROUP_KEY,
  companyLabel: SIX_GROUP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSixGroupJobs,
  isCompanyJob: isSixGroupJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ SIX Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
