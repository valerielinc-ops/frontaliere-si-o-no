#!/usr/bin/env node
/**
 * Dedicated Huntsman Corporation crawler runner.
 *
 * Uses the standard crawler template with the Huntsman Corporation parser.
 * All fetch/parse logic lives in ./lib/huntsman-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHuntsmanJobs,
  isHuntsmanJob,
  isTrustedDomain,
  HUNTSMAN_KEY,
  HUNTSMAN_COMPANY_NAME,
} from './lib/huntsman-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HUNTSMAN_KEY,
  companyLabel: HUNTSMAN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHuntsmanJobs,
  isCompanyJob: isHuntsmanJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Huntsman Corporation crawler failed: ${err?.message || err}`);
  process.exit(1);
});
