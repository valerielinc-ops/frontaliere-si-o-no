#!/usr/bin/env node
/**
 * Dedicated Grischa Personal AG crawler runner.
 *
 * Uses the standard crawler template with the Grischa Personal AG parser.
 * All fetch/parse logic lives in ./lib/grischapersonal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGrischapersonalJobs,
  isGrischapersonalJob,
  isTrustedDomain,
  GRISCHAPERSONAL_KEY,
  GRISCHAPERSONAL_COMPANY_NAME,
} from './lib/grischapersonal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GRISCHAPERSONAL_KEY,
  companyLabel: GRISCHAPERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGrischapersonalJobs,
  isCompanyJob: isGrischapersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Grischa Personal AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
