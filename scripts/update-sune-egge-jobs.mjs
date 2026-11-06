#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSuneEggeJobs,
  isSuneEggeJob,
  isTrustedDomain,
  SUNE_EGGE_KEY,
  SUNE_EGGE_COMPANY_NAME,
} from './lib/sune-egge-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SUNE_EGGE_KEY,
  companyLabel: SUNE_EGGE_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSuneEggeJobs,
  isCompanyJob: isSuneEggeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Sune-Egge crawler failed: ${err?.message || err}`);
  process.exit(1);
});
