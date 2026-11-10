#!/usr/bin/env node
/**
 * Dedicated PRODYNA (Schweiz) AG crawler runner.
 *
 * Uses the standard crawler template with the PRODYNA (Schweiz) AG parser.
 * All fetch/parse logic lives in ./lib/prodyna-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllProdynaComJobs,
  isProdynaComJob,
  isTrustedDomain,
  PRODYNA_COM_KEY,
  PRODYNA_COM_COMPANY_NAME,
} from './lib/prodyna-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PRODYNA_COM_KEY,
  companyLabel: PRODYNA_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllProdynaComJobs,
  isCompanyJob: isProdynaComJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ PRODYNA (Schweiz) AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
