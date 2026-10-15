#!/usr/bin/env node
/**
 * Dedicated SRO AG (Spital Region Oberaargau) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSroJobs,
  isSroJob,
  isTrustedDomain,
  SRO_KEY,
  SRO_COMPANY_NAME,
} from './lib/sro-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SRO_KEY,
  companyLabel: SRO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSroJobs,
  isCompanyJob: isSroJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SRO crawler failed: ${err?.message || err}`);
  process.exit(1);
});
