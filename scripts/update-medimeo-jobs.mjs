#!/usr/bin/env node
/**
 * Dedicated Medimeo AG crawler runner.
 *
 * Uses the standard crawler template with the Medimeo AG parser.
 * All fetch/parse logic lives in ./lib/medimeo-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedimeoJobs,
  isMedimeoJob,
  isTrustedDomain,
  MEDIMEO_KEY,
  MEDIMEO_COMPANY_NAME,
} from './lib/medimeo-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MEDIMEO_KEY,
  companyLabel: MEDIMEO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMedimeoJobs,
  isCompanyJob: isMedimeoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Medimeo AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
