#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStiftungKindAutismusJobs,
  isStiftungKindAutismusJob,
  isTrustedDomain,
  STIFTUNG_KIND_AUTISMUS_KEY,
  STIFTUNG_KIND_AUTISMUS_COMPANY_NAME,
} from './lib/stiftung-kind-autismus-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: STIFTUNG_KIND_AUTISMUS_KEY,
  companyLabel: STIFTUNG_KIND_AUTISMUS_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllStiftungKindAutismusJobs,
  isCompanyJob: isStiftungKindAutismusJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Stiftung Kind und Autismus crawler failed: ${err?.message || err}`); process.exit(1); });
