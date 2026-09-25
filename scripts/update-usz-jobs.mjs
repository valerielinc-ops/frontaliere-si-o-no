#!/usr/bin/env node
/**
 * Dedicated Universitätsspital Zürich (USZ) crawler runner.
 *
 * Uses the standard crawler template with the Universitätsspital Zürich (USZ) parser.
 * All fetch/parse logic lives in ./lib/usz-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUszJobs,
  isUszJob,
  isTrustedDomain,
  USZ_KEY,
  USZ_COMPANY_NAME,
} from './lib/usz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: USZ_KEY,
  companyLabel: USZ_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUszJobs,
  isCompanyJob: isUszJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Universitätsspital Zürich (USZ) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
