#!/usr/bin/env node
/**
 * Dedicated EVAM (Établissement vaudois de l'accueil des migrants) crawler runner.
 *
 * Uses the standard crawler template with the EVAM parser. All fetch/parse
 * logic lives in ./lib/evam-vaud-job-parser.mjs.
 *
 * Source language is French ('fr') — Vaud is a French-speaking canton,
 * unlike most of this campaign's German-speaking cantons.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  fetchAllEvamVaudJobs,
  isEvamVaudJob,
  isTrustedDomain,
  EVAM_VAUD_KEY,
  EVAM_VAUD_COMPANY_NAME,
} from './lib/evam-vaud-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: EVAM_VAUD_KEY,
  companyLabel: EVAM_VAUD_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllEvamVaudJobs,
  isCompanyJob: isEvamVaudJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
  matchKey: (job) => extractStableJobId(job.url) || job.url,
}).catch((err) => {
  console.error(`❌ EVAM crawler failed: ${err?.message || err}`);
  process.exit(1);
});
