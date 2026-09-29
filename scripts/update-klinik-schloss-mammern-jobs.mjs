#!/usr/bin/env node
/**
 * Dedicated Klinik Schloss Mammern crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikSchlossMammernJobs,
  isKlinikSchlossMammernJob,
  isTrustedDomain,
  KLINIK_SCHLOSS_MAMMERN_KEY,
  KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME,
  KLINIK_SCHLOSS_MAMMERN_FABRICATED_DESCRIPTION_RE,
} from './lib/klinik-schloss-mammern-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_SCHLOSS_MAMMERN_KEY,
  companyLabel: KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikSchlossMammernJobs,
  isCompanyJob: isKlinikSchlossMammernJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, KLINIK_SCHLOSS_MAMMERN_FABRICATED_DESCRIPTION_RE, KLINIK_SCHLOSS_MAMMERN_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Klinik Schloss Mammern crawler failed: ${err?.message || err}`);
  process.exit(1);
});
