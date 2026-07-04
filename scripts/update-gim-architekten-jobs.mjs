#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGimArchitektenJobs,
  isGimArchitektenJob,
  isTrustedDomain,
  GIM_ARCHITEKTEN_KEY,
  GIM_ARCHITEKTEN_COMPANY_NAME,
} from './lib/gim-architekten-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GIM_ARCHITEKTEN_KEY,
  companyLabel: GIM_ARCHITEKTEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGimArchitektenJobs,
  isCompanyJob: isGimArchitektenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ GIM Architekten AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
