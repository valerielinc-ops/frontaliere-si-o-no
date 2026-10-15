#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRehabBaselJobs,
  isRehabBaselJob,
  isTrustedDomain,
  REHAB_BASEL_KEY,
  REHAB_BASEL_COMPANY_NAME,
  REHAB_BASEL_FABRICATED_DESCRIPTION_RE,
} from './lib/rehab-basel-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: REHAB_BASEL_KEY,
  companyLabel: REHAB_BASEL_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllRehabBaselJobs,
  isCompanyJob: isRehabBaselJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, REHAB_BASEL_FABRICATED_DESCRIPTION_RE, REHAB_BASEL_COMPANY_NAME),
}).catch((err) => { console.error(`❌ REHAB Basel crawler failed: ${err?.message || err}`); process.exit(1); });
