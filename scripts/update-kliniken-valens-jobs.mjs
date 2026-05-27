#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikenValensJobs,
  isKlinikenValensJob,
  isTrustedDomain,
  KLINIKEN_VALENS_KEY,
  KLINIKEN_VALENS_COMPANY_NAME,
} from './lib/kliniken-valens-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: KLINIKEN_VALENS_KEY,
  companyLabel: KLINIKEN_VALENS_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllKlinikenValensJobs,
  isCompanyJob: isKlinikenValensJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Kliniken Valens crawler failed: ${err?.message || err}`); process.exit(1); });
