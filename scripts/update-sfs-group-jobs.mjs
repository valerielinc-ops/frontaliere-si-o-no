#!/usr/bin/env node
/**
 * Dedicated SFS Group crawler runner.
 *
 * Uses the standard crawler template with the SFS Group parser.
 * All fetch/parse logic lives in ./lib/sfs-group-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSfsGroupJobs,
  isSfsGroupJob,
  isTrustedDomain,
  SFS_GROUP_KEY,
  SFS_GROUP_COMPANY_NAME,
} from './lib/sfs-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SFS_GROUP_KEY,
  companyLabel: SFS_GROUP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSfsGroupJobs,
  isCompanyJob: isSfsGroupJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ SFS Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
