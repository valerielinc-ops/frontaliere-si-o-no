#!/usr/bin/env node
/**
 * Dedicated migrolino crawler runner.
 *
 * Uses the standard crawler template with the migrolino parser.
 * All fetch/parse logic lives in ./lib/migrolino-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllMigrolinoJobs,
  isMigrolinoJob,
  isTrustedDomain,
  MIGROLINO_KEY,
  MIGROLINO_COMPANY_NAME,
} from './lib/migrolino-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: MIGROLINO_KEY,
  companyLabel: MIGROLINO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllMigrolinoJobs,
  isCompanyJob: isMigrolinoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ migrolino crawler failed: ${err?.message || err}`);
  process.exit(1);
});
