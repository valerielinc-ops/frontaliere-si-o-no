#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPzmMuensingenJobs,
  isPzmMuensingenJob,
  isTrustedDomain,
  PZM_MUENSINGEN_KEY,
  PZM_MUENSINGEN_COMPANY_NAME,
} from './lib/pzm-muensingen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: PZM_MUENSINGEN_KEY,
  companyLabel: PZM_MUENSINGEN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllPzmMuensingenJobs,
  isCompanyJob: isPzmMuensingenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ PZM Münsingen crawler failed: ${err?.message || err}`); process.exit(1); });
