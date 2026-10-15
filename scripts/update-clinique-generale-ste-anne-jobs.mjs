#!/usr/bin/env node
/**
 * Dedicated Clinique Générale Ste-Anne crawler runner.
 *
 * Uses the standard crawler template with the Clinique Générale Ste-Anne parser.
 * All fetch/parse logic lives in ./lib/clinique-generale-ste-anne-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import { authoritativeEmptySnapshotValidator } from './lib/authoritative-empty-snapshot.mjs';
import {
  fetchAllCliniqueGeneraleSteAnneJobs,
  isCliniqueGeneraleSteAnneJob,
  isTrustedDomain,
  CLINIQUE_GENERALE_STE_ANNE_KEY,
  CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME,
} from './lib/clinique-generale-ste-anne-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINIQUE_GENERALE_STE_ANNE_KEY,
  companyLabel: CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllCliniqueGeneraleSteAnneJobs,
  isCompanyJob: isCliniqueGeneraleSteAnneJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
  // The SMN directory proves an idle board only when the configured department
  // is still present and non-archived. An unproven zero keeps the old slice.
  validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME),
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Clinique Générale Ste-Anne crawler failed: ${err?.message || err}`);
  process.exit(1);
});
