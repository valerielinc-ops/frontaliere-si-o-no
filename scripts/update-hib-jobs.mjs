#!/usr/bin/env node
/**
 * Dedicated HIB (Hôpital Intercantonal de la Broye) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHibJobs,
  isHibJob,
  isTrustedDomain,
  HIB_KEY,
  HIB_COMPANY_NAME,
} from './lib/hib-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HIB_KEY,
  companyLabel: HIB_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHibJobs,
  isCompanyJob: isHibJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ HIB crawler failed: ${err?.message || err}`);
  process.exit(1);
});
