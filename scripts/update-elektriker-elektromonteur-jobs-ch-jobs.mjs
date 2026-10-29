#!/usr/bin/env node
/**
 * Dedicated elektriker-elektromonteur-jobs crawler runner.
 *
 * Uses the standard crawler template with the elektriker-elektromonteur-jobs parser.
 * All fetch/parse logic lives in ./lib/elektriker-elektromonteur-jobs-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllElektrikerElektromonteurJobsChJobs,
  isElektrikerElektromonteurJobsChJob,
  isTrustedDomain,
  ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_KEY,
  ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_COMPANY_NAME,
} from './lib/elektriker-elektromonteur-jobs-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_KEY,
  companyLabel: ELEKTRIKER_ELEKTROMONTEUR_JOBS_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllElektrikerElektromonteurJobsChJobs,
  isCompanyJob: isElektrikerElektromonteurJobsChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ elektriker-elektromonteur-jobs crawler failed: ${err?.message || err}`);
  process.exit(1);
});
