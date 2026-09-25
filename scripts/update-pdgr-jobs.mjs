#!/usr/bin/env node
/**
 * Dedicated Psychiatrische Dienste Graubünden crawler runner.
 *
 * Uses the standard crawler template with the Psychiatrische Dienste Graubünden parser.
 * All fetch/parse logic lives in ./lib/pdgr-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPdgrJobs,
  isPdgrJob,
  isTrustedDomain,
  PDGR_KEY,
  PDGR_COMPANY_NAME,
} from './lib/pdgr-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PDGR_KEY,
  companyLabel: PDGR_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPdgrJobs,
  isCompanyJob: isPdgrJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Psychiatrische Dienste Graubünden crawler failed: ${err?.message || err}`);
  process.exit(1);
});
