#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCsBregagliaJobs,
  isCsBregagliaJob,
  isTrustedDomain,
  CS_BREGAGLIA_KEY,
  CS_BREGAGLIA_COMPANY_NAME,
  CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE,
} from './lib/cs-bregaglia-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: CS_BREGAGLIA_KEY,
  companyLabel: CS_BREGAGLIA_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllCsBregagliaJobs,
  isCompanyJob: isCsBregagliaJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, CS_BREGAGLIA_FABRICATED_DESCRIPTION_RE, CS_BREGAGLIA_COMPANY_NAME),
}).catch((err) => { console.error(`❌ CS Bregaglia crawler failed: ${err?.message || err}`); process.exit(1); });
