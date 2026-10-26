#!/usr/bin/env node
/**
 * Dedicated WALTER ZOO AG GOSSAU crawler runner.
 *
 * Uses the standard crawler template with the WALTER ZOO AG GOSSAU parser.
 * All fetch/parse logic lives in ./lib/walter-zoo-ag-gossau-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllWalterZooAgGossauJobs,
  isWalterZooAgGossauJob,
  isTrustedDomain,
  WALTER_ZOO_AG_GOSSAU_KEY,
  WALTER_ZOO_AG_GOSSAU_COMPANY_NAME,
} from './lib/walter-zoo-ag-gossau-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: WALTER_ZOO_AG_GOSSAU_KEY,
  companyLabel: WALTER_ZOO_AG_GOSSAU_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllWalterZooAgGossauJobs,
  isCompanyJob: isWalterZooAgGossauJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ WALTER ZOO AG GOSSAU crawler failed: ${err?.message || err}`);
  process.exit(1);
});
