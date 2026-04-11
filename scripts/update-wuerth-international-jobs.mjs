#!/usr/bin/env node
/**
 * Dedicated Würth International AG crawler runner.
 *
 * Würth International is part of the Würth Group, the world's largest
 * trading company for assembly and fastening materials. HQ in Chur (GR).
 *
 * Uses the standard crawler template with the Würth International parser.
 * All fetch/parse logic lives in ./lib/wuerth-international-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllWuerthInternationalJobs,
  isWuerthInternationalJob,
  isTrustedDomain,
  WUERTH_INTERNATIONAL_KEY,
  WUERTH_INTERNATIONAL_COMPANY_NAME,
} from './lib/wuerth-international-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: WUERTH_INTERNATIONAL_KEY,
  companyLabel: WUERTH_INTERNATIONAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllWuerthInternationalJobs,
  isCompanyJob: isWuerthInternationalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`\u274C Würth International crawler failed: ${err?.message || err}`);
  process.exit(1);
});
