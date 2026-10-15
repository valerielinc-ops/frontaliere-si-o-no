#!/usr/bin/env node
/**
 * Dedicated ETH Zürich crawler runner.
 *
 * Uses the standard crawler template with the ETH Zürich parser.
 * All fetch/parse logic lives in ./lib/eth-zurich-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllEthZurichJobs,
  isEthZurichJob,
  isTrustedDomain,
  ETH_ZURICH_KEY,
  ETH_ZURICH_COMPANY_NAME,
} from './lib/eth-zurich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ETH_ZURICH_KEY,
  companyLabel: ETH_ZURICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEthZurichJobs,
  isCompanyJob: isEthZurichJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ ETH Zürich crawler failed: ${err?.message || err}`);
  process.exit(1);
});
