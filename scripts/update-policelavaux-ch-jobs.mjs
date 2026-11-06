#!/usr/bin/env node
/**
 * Dedicated Police Lavaux crawler runner.
 *
 * Uses the standard crawler template with the Police Lavaux parser.
 * All fetch/parse logic lives in ./lib/policelavaux-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPolicelavauxChJobs,
  isPolicelavauxChJob,
  isTrustedDomain,
  POLICELAVAUX_CH_KEY,
  POLICELAVAUX_CH_COMPANY_NAME,
} from './lib/policelavaux-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: POLICELAVAUX_CH_KEY,
  companyLabel: POLICELAVAUX_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPolicelavauxChJobs,
  isCompanyJob: isPolicelavauxChJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Police Lavaux crawler failed: ${err?.message || err}`);
  process.exit(1);
});
