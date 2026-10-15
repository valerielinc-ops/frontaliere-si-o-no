#!/usr/bin/env node
/**
 * Dedicated ANYbotics crawler runner.
 *
 * Uses the standard crawler template with the ANYbotics parser.
 * All fetch/parse logic lives in ./lib/anybotics-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAnyboticsJobs,
  isAnyboticsJob,
  isTrustedDomain,
  ANYBOTICS_KEY,
  ANYBOTICS_COMPANY_NAME,
} from './lib/anybotics-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ANYBOTICS_KEY,
  companyLabel: ANYBOTICS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAnyboticsJobs,
  isCompanyJob: isAnyboticsJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ ANYbotics crawler failed: ${err?.message || err}`);
  process.exit(1);
});
