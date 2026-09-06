#!/usr/bin/env node
/**
 * Dedicated Anker Swiss Ticino AG crawler runner.
 *
 * Uses the standard crawler template with the Anker Swiss Ticino AG parser.
 * All fetch/parse logic lives in ./lib/anker-swiss-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllAnkerSwissJobs,
  isAnkerSwissJob,
  isTrustedDomain,
  ANKER_SWISS_KEY,
  ANKER_SWISS_COMPANY_NAME,
} from './lib/anker-swiss-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ANKER_SWISS_KEY,
  companyLabel: ANKER_SWISS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllAnkerSwissJobs,
  isCompanyJob: isAnkerSwissJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Anker Swiss Ticino AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
