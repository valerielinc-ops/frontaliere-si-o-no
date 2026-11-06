#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllArsanteJobs,
  isArsanteJob,
  isTrustedDomain,
  ARSANTE_KEY,
  ARSANTE_COMPANY_NAME,
} from './lib/arsante-clinique-de-carouge-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: ARSANTE_KEY,
  companyLabel: ARSANTE_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllArsanteJobs,
  isCompanyJob: isArsanteJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => { console.error(`❌ Arsanté crawler failed: ${err?.message || err}`); process.exit(1); });
