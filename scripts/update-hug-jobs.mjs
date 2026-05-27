#!/usr/bin/env node
/**
 * Dedicated HUG — Hôpitaux Universitaires de Genève crawler runner.
 *
 * Uses the standard crawler template with the HUG — Hôpitaux Universitaires de Genève parser.
 * All fetch/parse logic lives in ./lib/hug-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHugJobs,
  isHugJob,
  isTrustedDomain,
  HUG_KEY,
  HUG_COMPANY_NAME,
} from './lib/hug-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HUG_KEY,
  companyLabel: HUG_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHugJobs,
  isCompanyJob: isHugJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ HUG — Hôpitaux Universitaires de Genève crawler failed: ${err?.message || err}`);
  process.exit(1);
});
