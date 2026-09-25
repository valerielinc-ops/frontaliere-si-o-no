#!/usr/bin/env node
/**
 * Dedicated Victorinox crawler runner.
 *
 * Uses the standard crawler template with the Victorinox parser.
 * All fetch/parse logic lives in ./lib/victorinox-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVictorinoxJobs,
  isVictorinoxJob,
  isTrustedDomain,
  VICTORINOX_KEY,
  VICTORINOX_COMPANY_NAME,
} from './lib/victorinox-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VICTORINOX_KEY,
  companyLabel: VICTORINOX_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVictorinoxJobs,
  isCompanyJob: isVictorinoxJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Victorinox crawler failed: ${err?.message || err}`);
  process.exit(1);
});
