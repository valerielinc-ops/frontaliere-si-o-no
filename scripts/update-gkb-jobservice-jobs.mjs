#!/usr/bin/env node
/**
 * Dedicated GKB JobService crawler runner.
 *
 * Uses the standard crawler template with the GKB JobService parser.
 * All fetch/parse logic lives in ./lib/gkb-jobservice-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGkbJobserviceJobs,
  isGkbJobserviceJob,
  isTrustedDomain,
  GKB_JOBSERVICE_KEY,
  GKB_JOBSERVICE_COMPANY_NAME,
} from './lib/gkb-jobservice-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GKB_JOBSERVICE_KEY,
  companyLabel: GKB_JOBSERVICE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGkbJobserviceJobs,
  isCompanyJob: isGkbJobserviceJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ GKB JobService crawler failed: ${err?.message || err}`);
  process.exit(1);
});
