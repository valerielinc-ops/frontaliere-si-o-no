#!/usr/bin/env node
/**
 * Dedicated Engadin Tourismus AG (St. Moritz, GR) crawler runner.
 *
 * Career page: https://www.engadintourismus.ch/unternehmen/jobs
 * TYPO3-based CMS. Small tourism organization, typically 1-5 positions.
 *
 * Uses the standard crawler template. All parse logic in
 * ./lib/engadin-tourismus-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { withSourceLangRelabelFlags } from './lib/source-lang-relabel.mjs';
import {
  fetchAllEngadinTourismusJobs,
  isEngadinTourismusJob,
  isTrustedDomain,
  ENGADIN_TOURISMUS_KEY,
  ENGADIN_TOURISMUS_COMPANY_NAME,
} from './lib/engadin-tourismus-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ENGADIN_TOURISMUS_KEY,
  companyLabel: ENGADIN_TOURISMUS_COMPANY_NAME,
  root: ROOT,
  // The parser now reads the language from the body (issue 5253); jobs whose
  // stored sourceLang changed get their stale non-source slots retranslated.
  fetchJobs: withSourceLangRelabelFlags(fetchAllEngadinTourismusJobs, ENGADIN_TOURISMUS_KEY),
  isCompanyJob: isEngadinTourismusJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`Engadin Tourismus crawler failed: ${err?.message || err}`);
  process.exit(1);
});
