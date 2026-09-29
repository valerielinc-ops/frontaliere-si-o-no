#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { repairStoredCrawlerSlice } from './lib/stored-slice-repair.mjs';
import {
  dropPlanzerFabricatedText,
  fetchAllPlanzerJobs,
  isPlanzerJob,
  isTrustedDomain,
  PLANZER_KEY,
  PLANZER_COMPANY_NAME,
} from './lib/planzer-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Stored jobs from the old description builder (brand sentence, crawler
// section labels, synthetic summary): the pipeline's merge would keep their
// translations, so drop them from the slice first; the localization step
// then translates the posting's own text (issue 5253).
const repaired = repairStoredCrawlerSlice(ROOT, PLANZER_KEY, dropPlanzerFabricatedText);
if (repaired > 0) {
  console.log(`🧹 Planzer: dropped crawler-written text and its translations from ${repaired} stored job(s); they will be retranslated`);
}

runStandardCrawlerPipeline({
  companyKey: PLANZER_KEY,
  companyLabel: PLANZER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPlanzerJobs,
  isCompanyJob: isPlanzerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Planzer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
