#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllProSenectuteTiJobs,
  isProSenectuteTiJob,
  isTrustedDomain,
  PROSENECTUTE_TI_KEY,
  PROSENECTUTE_TI_COMPANY_NAME,
} from './lib/prosenectute-ti-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: PROSENECTUTE_TI_KEY,
  companyLabel: PROSENECTUTE_TI_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllProSenectuteTiJobs,
  isCompanyJob: isProSenectuteTiJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => { console.error(`❌ Pro Senectute TI crawler failed: ${err?.message || err}`); process.exit(1); });
