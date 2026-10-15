#!/usr/bin/env node
/**
 * Dedicated Fachhochschule Graubünden crawler runner.
 *
 * Uses the standard crawler template with the Fachhochschule Graubünden parser.
 * All fetch/parse logic lives in ./lib/fhgr-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFhgrJobs,
  isFhgrJob,
  isTrustedDomain,
  FHGR_KEY,
  FHGR_COMPANY_NAME,
} from './lib/fhgr-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FHGR_KEY,
  companyLabel: FHGR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFhgrJobs,
  isCompanyJob: isFhgrJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Fachhochschule Graubünden crawler failed: ${err?.message || err}`);
  process.exit(1);
});
