#!/usr/bin/env node
/**
 * Dedicated Fondation Soins Lausanne crawler runner.
 *
 * All fetch/parse logic lives in ./lib/fondation-soins-lausanne-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFondationSoinsLausanneJobs,
  isFondationSoinsLausanneJob,
  isTrustedDomain,
  FONDATION_SOINS_LAUSANNE_KEY,
  FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
} from './lib/fondation-soins-lausanne-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FONDATION_SOINS_LAUSANNE_KEY,
  companyLabel: FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFondationSoinsLausanneJobs,
  isCompanyJob: isFondationSoinsLausanneJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Fondation Soins Lausanne crawler failed: ${err?.message || err}`);
  process.exit(1);
});
