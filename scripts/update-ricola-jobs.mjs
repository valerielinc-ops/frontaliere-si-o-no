#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRicolaJobs,
  isRicolaJob,
  isTrustedDomain,
  RICOLA_KEY,
  RICOLA_COMPANY_NAME,
} from './lib/ricola-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RICOLA_KEY,
  companyLabel: RICOLA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRicolaJobs,
  isCompanyJob: isRicolaJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ ${RICOLA_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
