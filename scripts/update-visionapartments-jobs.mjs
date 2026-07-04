#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVisionapartmentsJobs,
  isVisionapartmentsJob,
  isTrustedDomain,
  VISIONAPARTMENTS_KEY,
  VISIONAPARTMENTS_COMPANY_NAME,
} from './lib/visionapartments-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VISIONAPARTMENTS_KEY,
  companyLabel: VISIONAPARTMENTS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVisionapartmentsJobs,
  isCompanyJob: isVisionapartmentsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ VISIONAPARTMENTS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
