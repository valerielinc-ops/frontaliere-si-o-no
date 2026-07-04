#!/usr/bin/env node
/**
 * Dedicated Carrosserie HESS AG crawler runner.
 *
 * Uses the standard crawler template with the HESS parser.
 * All fetch/parse logic lives in ./lib/hess-carrosserie-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHessCarrosserieJobs,
  isHessCarrosserieJob,
  isTrustedDomain,
  HESS_CARROSSERIE_KEY,
  HESS_CARROSSERIE_COMPANY_NAME,
} from './lib/hess-carrosserie-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HESS_CARROSSERIE_KEY,
  companyLabel: HESS_CARROSSERIE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHessCarrosserieJobs,
  isCompanyJob: isHessCarrosserieJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Carrosserie HESS AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
