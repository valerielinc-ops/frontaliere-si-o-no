#!/usr/bin/env node
/**
 * Dedicated Klinik Schützen Rheinfelden crawler runner.
 *
 * Uses the standard crawler template with the Klinik Schützen parser
 * (HTML in-page anchors on /ueber-uns/arbeiten-in-der-klinik).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSchuetzenJobs,
  isKlinikSchuetzenJob,
  isTrustedDomain,
  KLINIK_SCHUETZEN_KEY,
  KLINIK_SCHUETZEN_COMPANY_NAME,
} from './lib/klinik-schuetzen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SCHUETZEN_KEY,
  companyLabel: KLINIK_SCHUETZEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSchuetzenJobs,
  isCompanyJob: isKlinikSchuetzenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Klinik Schützen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
