#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVillaImParkJobs,
  isVillaImParkJob,
  isTrustedDomain,
  VILLA_IM_PARK_KEY,
  VILLA_IM_PARK_COMPANY_NAME,
} from './lib/villa-im-park-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: VILLA_IM_PARK_KEY,
  companyLabel: VILLA_IM_PARK_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllVillaImParkJobs,
  isCompanyJob: isVillaImParkJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Villa im Park crawler failed: ${err?.message || err}`);
  process.exit(1);
});
