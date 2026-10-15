#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVitreaGesundheitJobs,
  isVitreaGesundheitJob,
  isTrustedDomain,
  VITREA_GESUNDHEIT_KEY,
  VITREA_GESUNDHEIT_COMPANY_NAME,
  VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE,
} from './lib/vitrea-gesundheit-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: VITREA_GESUNDHEIT_KEY,
  companyLabel: VITREA_GESUNDHEIT_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllVitreaGesundheitJobs,
  isCompanyJob: isVitreaGesundheitJob,
  isTrustedDomain,
  // The onlyfy.jobs detail URL is `…/{lang}/job/{hash}`; the `{hash}` token is
  // non-hex so `extractStableJobId` can't derive a stable id and falls back to
  // the full URL — letting the `/de/` lang prefix (or the historical
  // `/job/`→`/de/job/` move) fragment the merge key and drop previousSlugs +
  // translations on re-crawl. Key on the stable `/job/{hash}` token instead.
  matchKey: (j) => (String(j?.url || '').match(/\/job\/([a-z0-9-]+)/i)?.[1] || j?.url || ''),
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, VITREA_GESUNDHEIT_FABRICATED_DESCRIPTION_RE, VITREA_GESUNDHEIT_COMPANY_NAME),
}).catch((err) => { console.error(`❌ Vitrea Gesundheit crawler failed: ${err?.message || err}`); process.exit(1); });
