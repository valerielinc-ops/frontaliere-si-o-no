#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHolmesPlaceJobs,
  isHolmesPlaceJob,
  isTrustedDomain,
  HOLMES_PLACE_KEY,
  HOLMES_PLACE_COMPANY_NAME,
} from './lib/holmes-place-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOLMES_PLACE_KEY,
  companyLabel: HOLMES_PLACE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHolmesPlaceJobs,
  isCompanyJob: isHolmesPlaceJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Holmes Place crawler failed: ${err?.message || err}`);
  process.exit(1);
});
