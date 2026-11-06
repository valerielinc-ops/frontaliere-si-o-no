#!/usr/bin/env node
/**
 * Dedicated RFSM - Réseau fribourgeois santé mentale crawler runner.
 *
 * Uses the standard crawler template with the RFSM - Réseau fribourgeois santé mentale parser.
 * All fetch/parse logic lives in ./lib/rfsm-fribourg-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRfsmFribourgJobs,
  isRfsmFribourgJob,
  isTrustedDomain,
  RFSM_FRIBOURG_KEY,
  RFSM_FRIBOURG_COMPANY_NAME,
} from './lib/rfsm-fribourg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RFSM_FRIBOURG_KEY,
  companyLabel: RFSM_FRIBOURG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRfsmFribourgJobs,
  isCompanyJob: isRfsmFribourgJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ RFSM - Réseau fribourgeois santé mentale crawler failed: ${err?.message || err}`);
  process.exit(1);
});
