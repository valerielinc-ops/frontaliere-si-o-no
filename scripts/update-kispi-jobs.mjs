#!/usr/bin/env node
/**
 * Dedicated Universitäts-Kinderspital Zürich (Kispi) crawler runner.
 *
 * Uses the standard crawler template with the Kispi parser
 * (Prospective.ch career-center, white-label HTML at
 * `stellen.kispi-jobs.ch`; JSON-LD JobPosting per detail page).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKispiJobs,
  isKispiJob,
  isTrustedDomain,
  KISPI_KEY,
  KISPI_COMPANY_NAME,
} from './lib/kispi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KISPI_KEY,
  companyLabel: KISPI_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKispiJobs,
  isCompanyJob: isKispiJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kispi crawler failed: ${err?.message || err}`);
  process.exit(1);
});
