#!/usr/bin/env node
/**
 * Dedicated IGS Bern (Soteria) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIgsBernJobs,
  isIgsBernJob,
  isTrustedDomain,
  IGS_BERN_KEY,
  IGS_BERN_COMPANY_NAME,
} from './lib/igs-bern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IGS_BERN_KEY,
  companyLabel: IGS_BERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIgsBernJobs,
  isCompanyJob: isIgsBernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ IGS Bern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
