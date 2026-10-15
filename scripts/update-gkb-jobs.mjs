#!/usr/bin/env node
/**
 * Dedicated Graubündner Kantonalbank crawler runner.
 *
 * Uses the standard crawler template with the Graubündner Kantonalbank parser.
 * All fetch/parse logic lives in ./lib/gkb-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGkbJobs,
  isGkbJob,
  isTrustedDomain,
  GKB_KEY,
  GKB_COMPANY_NAME,
} from './lib/gkb-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GKB_KEY,
  companyLabel: GKB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGkbJobs,
  isCompanyJob: isGkbJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Graubündner Kantonalbank crawler failed: ${err?.message || err}`);
  process.exit(1);
});
