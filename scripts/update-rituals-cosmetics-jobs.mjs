#!/usr/bin/env node
/**
 * Dedicated Rituals Cosmetics Switzerland crawler runner.
 *
 * Uses the standard crawler template with the Rituals Cosmetics Switzerland parser.
 * All fetch/parse logic lives in ./lib/rituals-cosmetics-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRitualsCosmeticsJobs,
  isRitualsCosmeticsJob,
  isTrustedDomain,
  RITUALS_COSMETICS_KEY,
  RITUALS_COSMETICS_COMPANY_NAME,
} from './lib/rituals-cosmetics-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RITUALS_COSMETICS_KEY,
  companyLabel: RITUALS_COSMETICS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRitualsCosmeticsJobs,
  isCompanyJob: isRitualsCosmeticsJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Rituals Cosmetics Switzerland crawler failed: ${err?.message || err}`);
  process.exit(1);
});
