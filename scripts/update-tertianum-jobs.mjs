#!/usr/bin/env node
/**
 * Dedicated Tertianum crawler runner.
 *
 * Uses the standard crawler template with the Tertianum parser.
 * All fetch/parse logic lives in ./lib/tertianum-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTertianumJobs,
  isTertianumJob,
  isTrustedDomain,
  TERTIANUM_KEY,
  TERTIANUM_COMPANY_NAME,
} from './lib/tertianum-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: TERTIANUM_KEY,
  companyLabel: TERTIANUM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllTertianumJobs,
  isCompanyJob: isTertianumJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Tertianum crawler failed: ${err?.message || err}`);
  process.exit(1);
});
