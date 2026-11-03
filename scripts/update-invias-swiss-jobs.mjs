#!/usr/bin/env node
/**
 * Dedicated Invias AG crawler runner.
 *
 * Uses the standard crawler template with the Invias AG parser.
 * All fetch/parse logic lives in ./lib/invias-swiss-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllInviasSwissJobs,
  isInviasSwissJob,
  isTrustedDomain,
  INVIAS_SWISS_KEY,
  INVIAS_SWISS_COMPANY_NAME,
} from './lib/invias-swiss-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INVIAS_SWISS_KEY,
  companyLabel: INVIAS_SWISS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllInviasSwissJobs,
  isCompanyJob: isInviasSwissJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Invias AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
