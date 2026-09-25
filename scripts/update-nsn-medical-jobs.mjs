#!/usr/bin/env node
/**
 * Dedicated NSN Medical Group crawler runner (Umantis tenant 2884).
 *
 * Covers NSN medical AG plus the affiliated entities advertising under the
 * same Umantis tenant: Zentrum für integrative Onkologie (ZIO), narkose.ch,
 * Limmatklinik and Eulachklinik.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNsnMedicalJobs,
  isNsnMedicalJob,
  isTrustedDomain,
  NSN_MEDICAL_KEY,
  NSN_MEDICAL_COMPANY_NAME,
} from './lib/nsn-medical-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NSN_MEDICAL_KEY,
  companyLabel: NSN_MEDICAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNsnMedicalJobs,
  isCompanyJob: isNsnMedicalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ NSN Medical crawler failed: ${err?.message || err}`);
  process.exit(1);
});
