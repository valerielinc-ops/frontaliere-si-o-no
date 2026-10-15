#!/usr/bin/env node
/**
 * Dedicated fachkraft.ch GmbH crawler runner.
 *
 * Uses the standard crawler template with the fachkraft.ch GmbH parser.
 * All fetch/parse logic lives in ./lib/fachkraft-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllFachkraftJobs,
  isFachkraftJob,
  isTrustedDomain,
  FACHKRAFT_KEY,
  FACHKRAFT_COMPANY_NAME,
  validateFachkraftAuthoritativeSnapshot,
} from './lib/fachkraft-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FACHKRAFT_KEY,
  companyLabel: FACHKRAFT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllFachkraftJobs,
  isCompanyJob: isFachkraftJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  validateAuthoritativeSnapshot: validateFachkraftAuthoritativeSnapshot,
  allowAuthoritativeEmptySnapshot: true,
}).catch((err) => {
  console.error(`❌ fachkraft.ch GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
