#!/usr/bin/env node
/**
 * Dedicated Faulhaber crawler runner.
 *
 * Uses the standard crawler template with the Faulhaber parser.
 * All fetch/parse logic lives in ./lib/faulhaber-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllFaulhaberJobs,
  isFaulhaberJob,
  isTrustedDomain,
  FAULHABER_KEY,
  FAULHABER_COMPANY_NAME,
} from './lib/faulhaber-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: FAULHABER_KEY,
  companyLabel: FAULHABER_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the language from the body (issue 5253); jobs whose
  // stored sourceLang changed get their stale non-source slots retranslated.
  fetchJobs: withSourceLangRelabelFlags(fetchAllFaulhaberJobs, FAULHABER_KEY),
  isCompanyJob: isFaulhaberJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Faulhaber crawler failed: ${err?.message || err}`);
  process.exit(1);
});
