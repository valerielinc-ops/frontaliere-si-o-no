#!/usr/bin/env node
/**
 * Dedicated Universitätsklinik Balgrist crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllBalgristJobs,
  isBalgristJob,
  isTrustedDomain,
  BALGRIST_KEY,
  BALGRIST_COMPANY_NAME,
} from './lib/balgrist-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: BALGRIST_KEY,
  companyLabel: BALGRIST_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllBalgristJobs,
  isCompanyJob: isBalgristJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Balgrist crawler failed: ${err?.message || err}`);
  process.exit(1);
});
