#!/usr/bin/env node
/**
 * Dedicated MediPersonal crawler runner.
 *
 * Uses the standard crawler template with the MediPersonal parser.
 * All fetch/parse logic lives in ./lib/med-ipersonal-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMedIpersonalJobs,
  isMedIpersonalJob,
  isTrustedDomain,
  MED_IPERSONAL_KEY,
  MED_IPERSONAL_COMPANY_NAME,
} from './lib/med-ipersonal-job-parser.mjs';
import { assertCompleteIpersonalSnapshot } from './lib/ipersonal-spec-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MED_IPERSONAL_KEY,
  companyLabel: MED_IPERSONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMedIpersonalJobs,
  isCompanyJob: isMedIpersonalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  validateAuthoritativeSnapshot: assertCompleteIpersonalSnapshot,
}).catch((err) => {
  console.error(`❌ MediPersonal crawler failed: ${err?.message || err}`);
  process.exit(1);
});
