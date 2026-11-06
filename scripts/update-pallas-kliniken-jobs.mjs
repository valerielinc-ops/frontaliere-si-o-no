#!/usr/bin/env node
/**
 * Dedicated Pallas Kliniken crawler runner.
 *
 * Flair HR career portal (`pallasjobs.careers.flair.hr`) with JSON-LD
 * JobPosting blocks per detail page.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPallasKlinikenJobs,
  isPallasKlinikenJob,
  isTrustedDomain,
  PALLAS_KLINIKEN_KEY,
  PALLAS_KLINIKEN_COMPANY_NAME,
} from './lib/pallas-kliniken-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PALLAS_KLINIKEN_KEY,
  companyLabel: PALLAS_KLINIKEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPallasKlinikenJobs,
  isCompanyJob: isPallasKlinikenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Pallas Kliniken crawler failed: ${err?.message || err}`);
  process.exit(1);
});
