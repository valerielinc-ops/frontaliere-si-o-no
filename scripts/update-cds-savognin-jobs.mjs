#!/usr/bin/env node
/**
 * Dedicated Center da Sanadad Savognin crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCdsSavogninJobs,
  isCdsSavogninJob,
  isTrustedDomain,
  CDS_SAVOGNIN_KEY,
  CDS_SAVOGNIN_COMPANY_NAME,
} from './lib/cds-savognin-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CDS_SAVOGNIN_KEY,
  companyLabel: CDS_SAVOGNIN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCdsSavogninJobs,
  isCompanyJob: isCdsSavogninJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ CDS Savognin crawler failed: ${err?.message || err}`);
  process.exit(1);
});
