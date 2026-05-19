#!/usr/bin/env node
/**
 * Dedicated HRC (Hôpital Riviera-Chablais) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHrcJobs,
  isHrcJob,
  isTrustedDomain,
  HRC_KEY,
  HRC_COMPANY_NAME,
} from './lib/hrc-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HRC_KEY,
  companyLabel: HRC_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHrcJobs,
  isCompanyJob: isHrcJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ HRC crawler failed: ${err?.message || err}`);
  process.exit(1);
});
