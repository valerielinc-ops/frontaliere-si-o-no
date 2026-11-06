#!/usr/bin/env node
/**
 * Dedicated Medizinisches Center Bonaduz crawler runner.
 *
 * Uses the standard crawler template with the Medizinisches Center Bonaduz parser.
 * All fetch/parse logic lives in ./lib/mcm-group-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMcmGroupJobs,
  isMcmGroupJob,
  isTrustedDomain,
  MCM_GROUP_KEY,
  MCM_GROUP_COMPANY_NAME,
} from './lib/mcm-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MCM_GROUP_KEY,
  companyLabel: MCM_GROUP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMcmGroupJobs,
  isCompanyJob: isMcmGroupJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Medizinisches Center Bonaduz crawler failed: ${err?.message || err}`);
  process.exit(1);
});
