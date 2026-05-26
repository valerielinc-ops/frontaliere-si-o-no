#!/usr/bin/env node
/**
 * Dedicated Clinique Générale-Beaulieu crawler runner.
 *
 * Uses the standard crawler template with the Clinique Générale-Beaulieu parser.
 * All fetch/parse logic lives in ./lib/clinique-generale-beaulieu-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllCliniqueGeneraleBeaulieuJobs,
  isCliniqueGeneraleBeaulieuJob,
  isTrustedDomain,
  CLINIQUE_GENERALE_BEAULIEU_KEY,
  CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME,
} from './lib/clinique-generale-beaulieu-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_GENERALE_BEAULIEU_KEY,
  companyLabel: CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueGeneraleBeaulieuJobs,
  isCompanyJob: isCliniqueGeneraleBeaulieuJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Clinique Générale-Beaulieu crawler failed: ${err?.message || err}`);
  process.exit(1);
});
