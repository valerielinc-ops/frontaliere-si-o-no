#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSpitexZuerichJobs,
  isSpitexZuerichJob,
  isTrustedDomain,
  SPITEX_ZUERICH_KEY,
  SPITEX_ZUERICH_COMPANY_NAME,
} from './lib/spitex-zuerich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: SPITEX_ZUERICH_KEY,
  companyLabel: SPITEX_ZUERICH_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllSpitexZuerichJobs,
  isCompanyJob: isSpitexZuerichJob,
  isTrustedDomain,
  // The onlyfy.jobs detail URL is `…/{lang}/job/{hash}`; the `{hash}` token is
  // non-hex so `extractStableJobId` can't derive a stable id and falls back to
  // the full URL — letting the `/de/` lang prefix (or the historical
  // `/job/`→`/de/job/` move) fragment the merge key and drop previousSlugs +
  // translations on re-crawl. Key on the stable `/job/{hash}` token instead.
  matchKey: (j) => (String(j?.url || '').match(/\/job\/([a-z0-9]+)/i)?.[1] || j?.url || ''),
  defaultSourceLang: 'de',
}).catch((err) => { console.error(`❌ Spitex Zürich crawler failed: ${err?.message || err}`); process.exit(1); });
