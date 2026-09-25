#!/usr/bin/env node
/**
 * Dedicated Bethesda Spital (Basel) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBethesdaSpitalJobs,
  isBethesdaSpitalJob,
  isTrustedDomain,
  BETHESDA_SPITAL_KEY,
  BETHESDA_SPITAL_COMPANY_NAME,
} from './lib/bethesda-spital-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BETHESDA_SPITAL_KEY,
  companyLabel: BETHESDA_SPITAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBethesdaSpitalJobs,
  isCompanyJob: isBethesdaSpitalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bethesda Spital crawler failed: ${err?.message || err}`);
  process.exit(1);
});
