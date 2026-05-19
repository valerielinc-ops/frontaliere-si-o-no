#!/usr/bin/env node
/**
 * Dedicated Klinik Barmelweid crawler runner.
 *
 * Uses the standard crawler template with the Klinik Barmelweid parser
 * (TYPO3 HTML listing at jobs.barmelweid.ch).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikBarmelweidJobs,
  isKlinikBarmelweidJob,
  isTrustedDomain,
  KLINIK_BARMELWEID_KEY,
  KLINIK_BARMELWEID_COMPANY_NAME,
} from './lib/klinik-barmelweid-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_BARMELWEID_KEY,
  companyLabel: KLINIK_BARMELWEID_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikBarmelweidJobs,
  isCompanyJob: isKlinikBarmelweidJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Barmelweid crawler failed: ${err?.message || err}`);
  process.exit(1);
});
