#!/usr/bin/env node
/**
 * Dedicated Franklin University Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Franklin University Switzerland parser.
 * All fetch/parse logic lives in ./lib/franklin-university-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFranklinUniversityJobs,
  isFranklinUniversityJob,
  isTrustedDomain,
  FRANKLIN_UNIVERSITY_KEY,
  FRANKLIN_UNIVERSITY_COMPANY_NAME,
} from './lib/franklin-university-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FRANKLIN_UNIVERSITY_KEY,
  companyLabel: FRANKLIN_UNIVERSITY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFranklinUniversityJobs,
  isCompanyJob: isFranklinUniversityJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ Franklin University Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
