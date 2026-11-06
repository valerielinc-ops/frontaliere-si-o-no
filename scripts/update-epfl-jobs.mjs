#!/usr/bin/env node
/**
 * Dedicated EPFL crawler runner.
 *
 * Uses the standard crawler template with the EPFL parser.
 * All fetch/parse logic lives in ./lib/epfl-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllEpflJobs,
  isEpflJob,
  isTrustedDomain,
  EPFL_KEY,
  EPFL_COMPANY_NAME,
} from './lib/epfl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EPFL_KEY,
  companyLabel: EPFL_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the source language from the body, not the title
  // (issue 5253): the jobs whose stored language changes get their
  // non-source locales retranslated, and their published URLs stay as they
  // are — the language is display metadata, not a reason to move a slug.
  fetchJobs: withSourceLangRelabelFlags(fetchAllEpflJobs, EPFL_KEY),
  isCompanyJob: isEpflJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  preserveExistingSlugs: true,
}).catch((err) => {
  console.error(`❌ EPFL crawler failed: ${err?.message || err}`);
  process.exit(1);
});
