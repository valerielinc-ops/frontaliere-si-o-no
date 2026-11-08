#!/usr/bin/env node
/**
 * Dedicated Freestar-Informatik AG crawler runner.
 *
 * Uses the standard crawler template with the Freestar-Informatik AG parser.
 * All fetch/parse logic lives in ./lib/freestarinformatik-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFreestarinformatikJobs,
  isFreestarinformatikJob,
  isTrustedDomain,
  FREESTARINFORMATIK_KEY,
  FREESTARINFORMATIK_COMPANY_NAME,
} from './lib/freestarinformatik-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FREESTARINFORMATIK_KEY,
  companyLabel: FREESTARINFORMATIK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFreestarinformatikJobs,
  isCompanyJob: isFreestarinformatikJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Freestar-Informatik AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
