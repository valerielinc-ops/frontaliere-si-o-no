#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehaklinikHaslibergJobs,
  isRehaklinikHaslibergJob,
  isTrustedDomain,
  REHAKLINIK_HASLIBERG_KEY,
  REHAKLINIK_HASLIBERG_COMPANY_NAME,
} from './lib/rehaklinik-hasliberg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: REHAKLINIK_HASLIBERG_KEY,
  companyLabel: REHAKLINIK_HASLIBERG_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRehaklinikHaslibergJobs,
  isCompanyJob: isRehaklinikHaslibergJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Rehaklinik Hasliberg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
