#!/usr/bin/env node
/**
 * Dedicated Hôpital ophtalmique Jules-Gonin crawler runner.
 *
 * All fetch/parse logic lives in ./lib/ophtalmique-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllOphtalmiqueJobs,
  isOphtalmiqueJob,
  isTrustedDomain,
  OPHTALMIQUE_KEY,
  OPHTALMIQUE_COMPANY_NAME,
} from './lib/ophtalmique-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: OPHTALMIQUE_KEY,
  companyLabel: OPHTALMIQUE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllOphtalmiqueJobs,
  isCompanyJob: isOphtalmiqueJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Hôpital ophtalmique crawler failed: ${err?.message || err}`);
  process.exit(1);
});
