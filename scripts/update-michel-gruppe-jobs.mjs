#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMichelGruppeJobs,
  isMichelGruppeJob,
  isTrustedDomain,
  MICHEL_GRUPPE_KEY,
  MICHEL_GRUPPE_COMPANY_NAME,
} from './lib/michel-gruppe-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: MICHEL_GRUPPE_KEY,
  companyLabel: MICHEL_GRUPPE_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllMichelGruppeJobs,
  isCompanyJob: isMichelGruppeJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Michel Gruppe AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
