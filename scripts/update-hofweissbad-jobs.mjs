#!/usr/bin/env node
/**
 * Dedicated Resort Hof Weissbad crawler runner.
 *
 * Uses the standard crawler template with the Hof Weissbad parser.
 * All fetch/parse logic lives in ./lib/hofweissbad-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHofweissbadJobs,
  isHofweissbadJob,
  isTrustedDomain,
  HOFWEISSBAD_KEY,
  HOFWEISSBAD_COMPANY_NAME,
} from './lib/hofweissbad-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HOFWEISSBAD_KEY,
  companyLabel: HOFWEISSBAD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHofweissbadJobs,
  isCompanyJob: isHofweissbadJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Hof Weissbad crawler failed: ${err?.message || err}`);
  process.exit(1);
});
