#!/usr/bin/env node
/**
 * Dedicated Physio swiss crawler runner.
 *
 * Uses the standard crawler template with the Physio swiss parser.
 * All fetch/parse logic lives in ./lib/physioswiss-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPhysioswissJobs,
  isPhysioswissJob,
  isTrustedDomain,
  PHYSIOSWISS_KEY,
  PHYSIOSWISS_COMPANY_NAME,
} from './lib/physioswiss-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PHYSIOSWISS_KEY,
  companyLabel: PHYSIOSWISS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPhysioswissJobs,
  isCompanyJob: isPhysioswissJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Physio swiss crawler failed: ${err?.message || err}`);
  process.exit(1);
});
