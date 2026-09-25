#!/usr/bin/env node
/**
 * Dedicated Bürgenstock Hotels AG crawler runner (Umantis tenant 2850).
 *
 * User scope decision: include ALL hotel + medical positions (no
 * post-filter). Waldhotel rehab clinic at Obbürgen is in scope; sister
 * BE property (Hotel Schweizerhof Bern) is in scope too.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBuergenstockHotelsJobs,
  isBuergenstockHotelsJob,
  isTrustedDomain,
  BUERGENSTOCK_HOTELS_KEY,
  BUERGENSTOCK_HOTELS_COMPANY_NAME,
} from './lib/buergenstock-hotels-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BUERGENSTOCK_HOTELS_KEY,
  companyLabel: BUERGENSTOCK_HOTELS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBuergenstockHotelsJobs,
  isCompanyJob: isBuergenstockHotelsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Bürgenstock Hotels crawler failed: ${err?.message || err}`);
  process.exit(1);
});
