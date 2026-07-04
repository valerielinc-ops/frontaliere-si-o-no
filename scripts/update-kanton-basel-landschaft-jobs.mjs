#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKantonBaselLandschaftJobs,
  isKantonBaselLandschaftJob,
  isTrustedDomain,
  KANTON_BASEL_LANDSCHAFT_KEY,
  KANTON_BASEL_LANDSCHAFT_COMPANY_NAME,
} from './lib/kanton-basel-landschaft-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KANTON_BASEL_LANDSCHAFT_KEY,
  companyLabel: KANTON_BASEL_LANDSCHAFT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKantonBaselLandschaftJobs,
  isCompanyJob: isKantonBaselLandschaftJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Kanton Basel-Landschaft crawler failed: ${err?.message || err}`); process.exit(1); });
