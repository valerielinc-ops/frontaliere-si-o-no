#!/usr/bin/env node
/**
 * Dedicated OMEGA SA crawler runner.
 *
 * Uses the standard crawler template with the OMEGA SA parser.
 * All fetch/parse logic lives in ./lib/omega-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOmegaJobs,
  isOmegaJob,
  isTrustedDomain,
  OMEGA_KEY,
  OMEGA_COMPANY_NAME,
} from './lib/omega-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OMEGA_KEY,
  companyLabel: OMEGA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOmegaJobs,
  isCompanyJob: isOmegaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ OMEGA SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
