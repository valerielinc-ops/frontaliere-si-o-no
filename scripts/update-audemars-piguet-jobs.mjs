#!/usr/bin/env node
/**
 * Dedicated Audemars Piguet crawler runner.
 *
 * Uses the standard crawler template with the Audemars Piguet parser.
 * All fetch/parse logic lives in ./lib/audemars-piguet-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAudemarsPiguetJobs,
  isAudemarsPiguetJob,
  isTrustedDomain,
  AUDEMARS_PIGUET_KEY,
  AUDEMARS_PIGUET_COMPANY_NAME,
} from './lib/audemars-piguet-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AUDEMARS_PIGUET_KEY,
  companyLabel: AUDEMARS_PIGUET_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAudemarsPiguetJobs,
  isCompanyJob: isAudemarsPiguetJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Audemars Piguet crawler failed: ${err?.message || err}`);
  process.exit(1);
});
