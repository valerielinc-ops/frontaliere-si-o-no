#!/usr/bin/env node
/**
 * Dedicated Universität Zürich crawler runner.
 *
 * Uses the standard crawler template with the Universität Zürich parser.
 * All fetch/parse logic lives in ./lib/uzh-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUzhJobs,
  isUzhJob,
  isTrustedDomain,
  UZH_KEY,
  UZH_COMPANY_NAME,
} from './lib/uzh-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UZH_KEY,
  companyLabel: UZH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUzhJobs,
  isCompanyJob: isUzhJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Universität Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
