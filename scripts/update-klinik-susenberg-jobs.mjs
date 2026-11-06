#!/usr/bin/env node
/**
 * Dedicated Klinik Susenberg crawler runner.
 *
 * Uses the standard crawler template with the Klinik Susenberg parser
 * (custom TYPO3 HTML scraping — PDF stellenausschreibungen).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSusenbergJobs,
  isKlinikSusenbergJob,
  isTrustedDomain,
  KLINIK_SUSENBERG_KEY,
  KLINIK_SUSENBERG_COMPANY_NAME,
  KLINIK_SUSENBERG_FABRICATED_DESCRIPTION_RE,
} from './lib/klinik-susenberg-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SUSENBERG_KEY,
  companyLabel: KLINIK_SUSENBERG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSusenbergJobs,
  isCompanyJob: isKlinikSusenbergJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, KLINIK_SUSENBERG_FABRICATED_DESCRIPTION_RE, KLINIK_SUSENBERG_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Klinik Susenberg crawler failed: ${err?.message || err}`);
  process.exit(1);
});
