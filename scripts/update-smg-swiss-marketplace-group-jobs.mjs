#!/usr/bin/env node
/**
 * Dedicated SMG Swiss Marketplace Group crawler runner.
 *
 * Uses the standard crawler template with the SMG Swiss Marketplace Group
 * parser. All fetch/parse logic lives in
 * ./lib/smg-swiss-marketplace-group-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSmgSwissMarketplaceGroupJobs,
  isSmgSwissMarketplaceGroupJob,
  isTrustedDomain,
  SMG_SWISS_MARKETPLACE_GROUP_KEY,
  SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME,
} from './lib/smg-swiss-marketplace-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SMG_SWISS_MARKETPLACE_GROUP_KEY,
  companyLabel: SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSmgSwissMarketplaceGroupJobs,
  isCompanyJob: isSmgSwissMarketplaceGroupJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ SMG Swiss Marketplace Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
