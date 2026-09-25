#!/usr/bin/env node
/**
 * Dedicated Adullam-Stiftung Basel & Riehen crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAdullamJobs,
  isAdullamJob,
  isTrustedDomain,
  ADULLAM_KEY,
  ADULLAM_COMPANY_NAME,
} from './lib/adullam-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ADULLAM_KEY,
  companyLabel: ADULLAM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAdullamJobs,
  isCompanyJob: isAdullamJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Adullam crawler failed: ${err?.message || err}`);
  process.exit(1);
});
