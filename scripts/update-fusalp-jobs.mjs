#!/usr/bin/env node
/**
 * Dedicated Fusalp crawler runner.
 *
 * Uses the standard crawler template with the Fusalp parser.
 * All fetch/parse logic lives in ./lib/fusalp-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFusalpJobs,
  isFusalpJob,
  isTrustedDomain,
  FUSALP_KEY,
  FUSALP_COMPANY_NAME,
} from './lib/fusalp-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FUSALP_KEY,
  companyLabel: FUSALP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFusalpJobs,
  isCompanyJob: isFusalpJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Fusalp crawler failed: ${err?.message || err}`);
  process.exit(1);
});
