#!/usr/bin/env node
/**
 * Dedicated CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät crawler runner.
 *
 * Uses the standard crawler template with the CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät parser.
 * All fetch/parse logic lives in ./lib/christinavassalli-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChristinavassalliJobs,
  isChristinavassalliJob,
  isTrustedDomain,
  CHRISTINAVASSALLI_KEY,
  CHRISTINAVASSALLI_COMPANY_NAME,
} from './lib/christinavassalli-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CHRISTINAVASSALLI_KEY,
  companyLabel: CHRISTINAVASSALLI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChristinavassalliJobs,
  isCompanyJob: isChristinavassalliJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ CHRISTINA VASSALLI Services, Inhaberin Denise Tschäppät crawler failed: ${err?.message || err}`);
  process.exit(1);
});
