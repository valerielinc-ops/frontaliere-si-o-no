#!/usr/bin/env node
/**
 * Dedicated iPersonal AG crawler runner.
 *
 * Uses the standard crawler template with the iPersonal AG parser.
 * All fetch/parse logic lives in ./lib/ipersonal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllIpersonalJobs,
  isIpersonalJob,
  isTrustedDomain,
  IPERSONAL_KEY,
  IPERSONAL_COMPANY_NAME,
} from './lib/ipersonal-job-parser.mjs';
import { assertCompleteIpersonalSnapshot } from './lib/ipersonal-spec-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: IPERSONAL_KEY,
  companyLabel: IPERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllIpersonalJobs,
  isCompanyJob: isIpersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  validateAuthoritativeSnapshot: assertCompleteIpersonalSnapshot,
}).catch((err) => {
  console.error(`❌ iPersonal AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
