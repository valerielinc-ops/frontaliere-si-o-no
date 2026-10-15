#!/usr/bin/env node
/**
 * Dedicated Galliker Transport AG crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGallikerJobs,
  isGallikerJob,
  isTrustedDomain,
  GALLIKER_KEY,
  GALLIKER_COMPANY_NAME,
} from './lib/galliker-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GALLIKER_KEY,
  companyLabel: GALLIKER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGallikerJobs,
  isCompanyJob: isGallikerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Galliker crawler failed: ${err?.message || err}`);
  process.exit(1);
});
