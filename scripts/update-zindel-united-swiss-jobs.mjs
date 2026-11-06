#!/usr/bin/env node
/**
 * Dedicated Zindel + Co. AG crawler runner.
 *
 * Uses the standard crawler template with the Zindel + Co. AG parser.
 * All fetch/parse logic lives in ./lib/zindel-united-swiss-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllZindelUnitedSwissJobs,
  isZindelUnitedSwissJob,
  isTrustedDomain,
  ZINDEL_UNITED_SWISS_KEY,
  ZINDEL_UNITED_SWISS_COMPANY_NAME,
} from './lib/zindel-united-swiss-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ZINDEL_UNITED_SWISS_KEY,
  companyLabel: ZINDEL_UNITED_SWISS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllZindelUnitedSwissJobs,
  isCompanyJob: isZindelUnitedSwissJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Zindel + Co. AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
