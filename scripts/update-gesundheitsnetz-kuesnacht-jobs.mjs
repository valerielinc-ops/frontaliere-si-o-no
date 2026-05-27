#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGesundheitsnetzKuesnachtJobs,
  isGesundheitsnetzKuesnachtJob,
  isTrustedDomain,
  GESUNDHEITSNETZ_KUESNACHT_KEY,
  GESUNDHEITSNETZ_KUESNACHT_COMPANY_NAME,
} from './lib/gesundheitsnetz-kuesnacht-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: GESUNDHEITSNETZ_KUESNACHT_KEY,
  companyLabel: GESUNDHEITSNETZ_KUESNACHT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllGesundheitsnetzKuesnachtJobs,
  isCompanyJob: isGesundheitsnetzKuesnachtJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Gesundheitsnetz Küsnacht crawler failed: ${err?.message || err}`); process.exit(1); });
