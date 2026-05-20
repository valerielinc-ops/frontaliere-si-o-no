#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllTherapiezentrumMeggenJobs,
  isTherapiezentrumMeggenJob,
  isTrustedDomain,
  THERAPIEZENTRUM_MEGGEN_KEY,
  THERAPIEZENTRUM_MEGGEN_COMPANY_NAME,
} from './lib/therapiezentrum-meggen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: THERAPIEZENTRUM_MEGGEN_KEY,
  companyLabel: THERAPIEZENTRUM_MEGGEN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllTherapiezentrumMeggenJobs,
  isCompanyJob: isTherapiezentrumMeggenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Therapiezentrum Meggen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
