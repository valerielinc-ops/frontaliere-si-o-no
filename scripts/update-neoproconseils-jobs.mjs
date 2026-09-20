#!/usr/bin/env node
/**
 * Dedicated NEO Pro conseils SA crawler runner.
 *
 * Uses the standard crawler template with the NEO Pro conseils SA parser.
 * All fetch/parse logic lives in ./lib/neoproconseils-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNeoproconseilsJobs,
  isNeoproconseilsJob,
  isTrustedDomain,
  NEOPROCONSEILS_KEY,
  NEOPROCONSEILS_COMPANY_NAME,
} from './lib/neoproconseils-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NEOPROCONSEILS_KEY,
  companyLabel: NEOPROCONSEILS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNeoproconseilsJobs,
  isCompanyJob: isNeoproconseilsJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ NEO Pro conseils SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
