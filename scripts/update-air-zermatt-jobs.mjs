#!/usr/bin/env node
/**
 * Dedicated Air Zermatt AG (Raron/Zermatt, VS) crawler runner.
 *
 * Air Zermatt career page: https://www.air-zermatt.ch/jobs
 * Small helicopter services company in Valais. Typically 2-5 positions.
 *
 * Uses the standard crawler template. All parse logic in
 * ./lib/air-zermatt-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllAirZermattJobs,
  isAirZermattJob,
  isTrustedDomain,
  AIR_ZERMATT_KEY,
  AIR_ZERMATT_COMPANY_NAME,
} from './lib/air-zermatt-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: AIR_ZERMATT_KEY,
  companyLabel: AIR_ZERMATT_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the language from the body (issue 5253); jobs whose
  // stored sourceLang changed get their stale non-source slots retranslated.
  fetchJobs: withSourceLangRelabelFlags(fetchAllAirZermattJobs, AIR_ZERMATT_KEY),
  isCompanyJob: isAirZermattJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`Air Zermatt crawler failed: ${err?.message || err}`);
  process.exit(1);
});
