#!/usr/bin/env node
/**
 * Dedicated Universitäts-Kinderspital Zürich (Kispi) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKispiZurichJobs,
  isKispiZurichJob,
  isTrustedDomain,
  KISPI_ZURICH_KEY,
  KISPI_ZURICH_COMPANY_NAME,
} from './lib/kispi-zurich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KISPI_ZURICH_KEY,
  companyLabel: KISPI_ZURICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKispiZurichJobs,
  isCompanyJob: isKispiZurichJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kispi Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
