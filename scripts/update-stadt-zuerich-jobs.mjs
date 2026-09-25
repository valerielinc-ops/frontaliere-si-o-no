#!/usr/bin/env node
/**
 * Dedicated Stadt Zürich (municipal administration) crawler runner.
 *
 * Uses the standard crawler template with the Stadt Zürich parser.
 * All fetch/parse logic lives in ./lib/stadt-zuerich-job-parser.mjs.
 *
 * NOT to be confused with `update-zurich-jobs.mjs` (Zurich Insurance Group —
 * a completely different, unrelated company).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStadtZuerichJobs,
  isStadtZuerichJob,
  isTrustedDomain,
  STADT_ZUERICH_KEY,
  STADT_ZUERICH_COMPANY_NAME,
} from './lib/stadt-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STADT_ZUERICH_KEY,
  companyLabel: STADT_ZUERICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStadtZuerichJobs,
  isCompanyJob: isStadtZuerichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Stadt Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
