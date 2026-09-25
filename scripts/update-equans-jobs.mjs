#!/usr/bin/env node
/**
 * Dedicated Equans Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Equans parser.
 * All fetch/parse logic lives in ./lib/equans-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEquansJobs,
  isEquansJob,
  isTrustedDomain,
  EQUANS_KEY,
  EQUANS_COMPANY_NAME,
} from './lib/equans-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EQUANS_KEY,
  companyLabel: EQUANS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEquansJobs,
  isCompanyJob: isEquansJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Equans Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
