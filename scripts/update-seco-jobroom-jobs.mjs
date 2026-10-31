#!/usr/bin/env node
/**
 * job-room.ch crawler runner. Fetch, filters and the run counters live in
 * ./lib/seco-jobroom-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSecoJobroomJobs,
  isSecoJobroomJob,
  isTrustedDomain,
  SECO_JOBROOM_KEY,
  SECO_JOBROOM_COMPANY_NAME,
} from './lib/seco-jobroom-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SECO_JOBROOM_KEY,
  companyLabel: SECO_JOBROOM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: () => fetchAllSecoJobroomJobs({ root: ROOT }),
  isCompanyJob: isSecoJobroomJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ ${SECO_JOBROOM_COMPANY_NAME} crawler failed: ${err?.message || err}`);
  process.exit(1);
});
