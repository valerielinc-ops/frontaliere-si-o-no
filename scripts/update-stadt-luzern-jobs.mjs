#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStadtLuzernJobs,
  isStadtLuzernJob,
  isTrustedDomain,
  STADT_LUZERN_KEY,
  STADT_LUZERN_COMPANY_NAME,
} from './lib/stadt-luzern-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: STADT_LUZERN_KEY,
  companyLabel: STADT_LUZERN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllStadtLuzernJobs,
  isCompanyJob: isStadtLuzernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Stadt Luzern crawler failed: ${err?.message || err}`); process.exit(1); });
