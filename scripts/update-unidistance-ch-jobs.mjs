#!/usr/bin/env node
/**
 * Dedicated UniDistance Suisse crawler runner.
 *
 * Uses the standard crawler template with the UniDistance Suisse parser.
 * All fetch/parse logic lives in ./lib/unidistance-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllUnidistanceChJobs,
  isUnidistanceChJob,
  isTrustedDomain,
  UNIDISTANCE_CH_KEY,
  UNIDISTANCE_CH_COMPANY_NAME,
} from './lib/unidistance-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: UNIDISTANCE_CH_KEY,
  companyLabel: UNIDISTANCE_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllUnidistanceChJobs,
  isCompanyJob: isUnidistanceChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ UniDistance Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
