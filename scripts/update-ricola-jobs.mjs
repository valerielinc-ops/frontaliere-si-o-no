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
  RICOLA_FABRICATED_DESCRIPTION_RE,
  RICOLA_LABEL_LINES_RE,
} from './lib/ricola-job-parser.mjs';
import { repairStoredUmantisJobs } from './lib/umantis-listing-common.mjs';

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
  prepareExistingJobs: (jobs) => repairStoredUmantisJobs(jobs, RICOLA_COMPANY_NAME, {
    fabricatedRe: RICOLA_FABRICATED_DESCRIPTION_RE,
    labelLinesRe: RICOLA_LABEL_LINES_RE,
  }),
}).catch((err) => {
  console.error(`❌ ${RICOLA_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
