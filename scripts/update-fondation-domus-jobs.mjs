#!/usr/bin/env node
/**
 * Dedicated Fondation Domus crawler runner.
 *
 * Uses the standard crawler template with the Fondation Domus parser.
 * All fetch/parse logic lives in ./lib/fondation-domus-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFondationDomusJobs,
  isFondationDomusJob,
  isTrustedDomain,
  FONDATION_DOMUS_KEY,
  FONDATION_DOMUS_COMPANY_NAME,
} from './lib/fondation-domus-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FONDATION_DOMUS_KEY,
  companyLabel: FONDATION_DOMUS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFondationDomusJobs,
  isCompanyJob: isFondationDomusJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Fondation Domus crawler failed: ${err?.message || err}`);
  process.exit(1);
});
