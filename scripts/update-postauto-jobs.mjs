#!/usr/bin/env node
/**
 * Dedicated PostAuto AG crawler runner.
 *
 * Uses the standard crawler template with the PostAuto parser.
 * All fetch/parse logic lives in ./lib/postauto-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPostAutoJobs,
  isPostAutoJob,
  isTrustedDomain,
  POSTAUTO_KEY,
  POSTAUTO_COMPANY_NAME,
} from './lib/postauto-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: POSTAUTO_KEY,
  companyLabel: POSTAUTO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPostAutoJobs,
  isCompanyJob: isPostAutoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ PostAuto crawler failed: ${err?.message || err}`);
  process.exit(1);
});
