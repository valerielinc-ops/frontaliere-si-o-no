#!/usr/bin/env node
/**
 * Dedicated Ostschweizer Kinderspital (Kispi SG) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKispiSgJobs,
  isKispiSgJob,
  isTrustedDomain,
  KISPI_SG_KEY,
  KISPI_SG_COMPANY_NAME,
} from './lib/kispi-sg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KISPI_SG_KEY,
  companyLabel: KISPI_SG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKispiSgJobs,
  isCompanyJob: isKispiSgJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ${KISPI_SG_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
