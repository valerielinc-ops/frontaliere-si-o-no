#!/usr/bin/env node
/**
 * Dedicated Climeworks crawler runner.
 *
 * Uses the standard crawler template with the Climeworks parser.
 * All fetch/parse logic lives in ./lib/climeworks-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClimeworksJobs,
  isClimeworksJob,
  isTrustedDomain,
  CLIMEWORKS_KEY,
  CLIMEWORKS_COMPANY_NAME,
} from './lib/climeworks-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLIMEWORKS_KEY,
  companyLabel: CLIMEWORKS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClimeworksJobs,
  isCompanyJob: isClimeworksJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Climeworks crawler failed: ${err?.message || err}`);
  process.exit(1);
});
