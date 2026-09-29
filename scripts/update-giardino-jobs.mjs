#!/usr/bin/env node
/**
 * Dedicated Giardino Group crawler runner.
 *
 * Uses the standard crawler template with the Giardino Group parser.
 * All fetch/parse logic lives in ./lib/giardino-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllGiardinoJobs,
  isGiardinoJob,
  isTrustedDomain,
  GIARDINO_KEY,
  GIARDINO_COMPANY_NAME,
  GIARDINO_INVENTED_INTRO_RE,
} from './lib/giardino-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GIARDINO_KEY,
  companyLabel: GIARDINO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGiardinoJobs,
  isCompanyJob: isGiardinoJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Stored descriptions opened by the former builder's own sentence
  // ("Giardino Group sucht für das …") and the translations made from them
  // go before the merge; the fresh crawl publishes the linked page's text.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, GIARDINO_INVENTED_INTRO_RE, GIARDINO_COMPANY_NAME),
  // Publish a zero only when the Talents board itself renders `jobs-count` 0
  // with an empty JOBS block (issue #6694). `empty-only` keeps the ordinary
  // miss-grace path for a non-empty batch; an unrecognised page or a board
  // whose cards do not parse returns a bare [] and keeps the previous slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(GIARDINO_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Giardino Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
