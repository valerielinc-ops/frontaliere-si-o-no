#!/usr/bin/env node
/**
 * Dedicated Globus crawler runner.
 *
 * Uses the standard crawler template with the Globus parser.
 * All fetch/parse logic lives in ./lib/globus-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGlobusJobs,
  isGlobusJob,
  isTrustedDomain,
  GLOBUS_KEY,
  GLOBUS_COMPANY_NAME,
} from './lib/globus-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GLOBUS_KEY,
  companyLabel: GLOBUS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGlobusJobs,
  isCompanyJob: isGlobusJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Globus crawler failed: ${err?.message || err}`);
  process.exit(1);
});
