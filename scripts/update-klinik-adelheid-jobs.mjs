#!/usr/bin/env node
/**
 * Dedicated Klinik Adelheid crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { repairStoredCrawlerSlice } from './lib/stored-slice-repair.mjs';
import {
  dropKlinikAdelheidFabricatedText,
  fetchAllKlinikAdelheidJobs,
  isKlinikAdelheidJob,
  isTrustedDomain,
  KLINIK_ADELHEID_KEY,
  KLINIK_ADELHEID_COMPANY_NAME,
} from './lib/klinik-adelheid-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Stored jobs written with the crawler's own lines keep their translations
// through the pipeline's locale-preserving merge: drop them from the slice
// first; the localization step then translates the page's text (issue 5253).
const repaired = repairStoredCrawlerSlice(ROOT, KLINIK_ADELHEID_KEY, dropKlinikAdelheidFabricatedText);
if (repaired > 0) {
  console.log(`🧹 Klinik Adelheid: dropped crawler-written text and its translations from ${repaired} stored job(s); they will be retranslated`);
}

runStandardCrawlerPipeline({
  companyKey: KLINIK_ADELHEID_KEY,
  companyLabel: KLINIK_ADELHEID_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikAdelheidJobs,
  isCompanyJob: isKlinikAdelheidJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Adelheid crawler failed: ${err?.message || err}`);
  process.exit(1);
});
