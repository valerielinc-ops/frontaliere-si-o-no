#!/usr/bin/env node
/**
 * Dedicated Fondation Rive-Neuve crawler runner.
 *
 * All fetch/parse logic lives in ./lib/riveneuve-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRiveneuveJobs,
  isRiveneuveJob,
  isTrustedDomain,
  RIVENEUVE_KEY,
  RIVENEUVE_COMPANY_NAME,
} from './lib/riveneuve-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RIVENEUVE_KEY,
  companyLabel: RIVENEUVE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRiveneuveJobs,
  isCompanyJob: isRiveneuveJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Rive-Neuve crawler failed: ${err?.message || err}`);
  process.exit(1);
});
