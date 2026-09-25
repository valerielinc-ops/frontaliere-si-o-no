#!/usr/bin/env node
/**
 * Dedicated Emil Egger AG crawler runner.
 *
 * Uses the standard crawler template with the Emil Egger AG parser.
 * All fetch/parse logic lives in ./lib/ete-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEteJobs,
  isEteJob,
  isTrustedDomain,
  ETE_KEY,
  ETE_COMPANY_NAME,
} from './lib/ete-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ETE_KEY,
  companyLabel: ETE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEteJobs,
  isCompanyJob: isEteJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  preserveExistingSlugs: true,
}).catch((err) => {
  console.error(`❌ Emil Egger AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
