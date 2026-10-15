#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGrandResortBadRagazJobs,
  isGrandResortBadRagazJob,
  isTrustedDomain,
  GRAND_RESORT_BAD_RAGAZ_KEY,
  GRAND_RESORT_BAD_RAGAZ_COMPANY_NAME,
} from './lib/grand-resort-bad-ragaz-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: GRAND_RESORT_BAD_RAGAZ_KEY,
  companyLabel: GRAND_RESORT_BAD_RAGAZ_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllGrandResortBadRagazJobs,
  isCompanyJob: isGrandResortBadRagazJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Grand Resort Bad Ragaz crawler failed: ${err?.message || err}`); process.exit(1); });
