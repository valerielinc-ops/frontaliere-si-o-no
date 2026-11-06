#!/usr/bin/env node
/**
 * Dedicated Institution de Lavigny crawler runner.
 *
 * All fetch/parse logic lives in ./lib/institution-lavigny-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllInstitutionLavignyJobs,
  isInstitutionLavignyJob,
  isTrustedDomain,
  INSTITUTION_LAVIGNY_KEY,
  INSTITUTION_LAVIGNY_COMPANY_NAME,
} from './lib/institution-lavigny-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: INSTITUTION_LAVIGNY_KEY,
  companyLabel: INSTITUTION_LAVIGNY_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllInstitutionLavignyJobs,
  isCompanyJob: isInstitutionLavignyJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Institution de Lavigny crawler failed: ${err?.message || err}`);
  process.exit(1);
});
