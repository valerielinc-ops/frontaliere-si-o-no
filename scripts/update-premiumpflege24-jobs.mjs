#!/usr/bin/env node
/**
 * Dedicated PremiumPflege24 GmbH crawler runner.
 *
 * Uses the standard crawler template with the PremiumPflege24 GmbH parser.
 * All fetch/parse logic lives in ./lib/premiumpflege24-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPremiumpflege24Jobs,
  isPremiumpflege24Job,
  isTrustedDomain,
  PREMIUMPFLEGE24_KEY,
  PREMIUMPFLEGE24_COMPANY_NAME,
} from './lib/premiumpflege24-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PREMIUMPFLEGE24_KEY,
  companyLabel: PREMIUMPFLEGE24_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPremiumpflege24Jobs,
  isCompanyJob: isPremiumpflege24Job,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ PremiumPflege24 GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
