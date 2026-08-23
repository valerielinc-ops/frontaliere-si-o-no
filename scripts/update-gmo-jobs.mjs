#!/usr/bin/env node
/**
 * Dedicated gmo crawler runner.
 *
 * Uses the standard crawler template with the gmo parser.
 * All fetch/parse logic lives in ./lib/gmo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGmoJobs,
  isGmoJob,
  isTrustedDomain,
  GMO_KEY,
  GMO_COMPANY_NAME,
} from './lib/gmo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GMO_KEY,
  companyLabel: GMO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGmoJobs,
  isCompanyJob: isGmoJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ gmo crawler failed: ${err?.message || err}`);
  process.exit(1);
});
