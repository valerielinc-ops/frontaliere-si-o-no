#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllDiakoniewerkJobs,
  isDiakoniewerkJob,
  isTrustedDomain,
  DIAKONIEWERK_KEY,
  DIAKONIEWERK_COMPANY_NAME,
} from './lib/diakoniewerk-neumuenster-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: DIAKONIEWERK_KEY,
  companyLabel: DIAKONIEWERK_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllDiakoniewerkJobs,
  isCompanyJob: isDiakoniewerkJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Diakoniewerk crawler failed: ${err?.message || err}`); process.exit(1); });
