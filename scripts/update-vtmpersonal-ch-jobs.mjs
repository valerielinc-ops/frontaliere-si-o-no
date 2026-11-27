#!/usr/bin/env node
/**
 * Dedicated VTM Dienstleistung AG crawler runner.
 *
 * Uses the standard crawler template with the VTM Dienstleistung AG parser.
 * All fetch/parse logic lives in ./lib/vtmpersonal-ch-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVtmpersonalChJobs,
  isVtmpersonalChJob,
  isTrustedDomain,
  VTMPERSONAL_CH_KEY,
  VTMPERSONAL_CH_COMPANY_NAME,
} from './lib/vtmpersonal-ch-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VTMPERSONAL_CH_KEY,
  companyLabel: VTMPERSONAL_CH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVtmpersonalChJobs,
  isCompanyJob: isVtmpersonalChJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ VTM Dienstleistung AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
