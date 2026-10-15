#!/usr/bin/env node
/**
 * Dedicated Geberit crawler runner.
 *
 * Uses the standard crawler template with the Geberit parser.
 * All fetch/parse logic lives in ./lib/geberit-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGeberitJobs,
  isGeberitJob,
  isTrustedDomain,
  GEBERIT_KEY,
  GEBERIT_COMPANY_NAME,
} from './lib/geberit-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GEBERIT_KEY,
  companyLabel: GEBERIT_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGeberitJobs,
  isCompanyJob: isGeberitJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Merge-continuity bridge across the source swap (sitemap → RMK API). The job
  // `url` changes namespace — old sitemap URL `…/job/…/<jobReqId 10-digit>/`
  // (extractStableJobId → `num:<id>`) vs new API `…/job-invite/<internalId 4-digit>/`
  // (no ≥6-digit token → full-URL key). The default url-based matchKey would never
  // match → every existing Geberit job dropped/expired and re-emitted fresh, losing
  // previousSlugs / titleByLocale / descriptionByLocale / firstSeenAt (reviewer 🔴).
  // The slug is the ONLY identity stable across both sources (both use
  // `slugify("<title> geberit ch")`), so match on it to preserve SEO equity +
  // translations. (No previousSlugs churn: the slug itself is unchanged.)
  matchKey: (job) => String(job?.slug || '').trim().toLowerCase(),
}).catch((err) => {
  console.error(`❌ Geberit crawler failed: ${err?.message || err}`);
  process.exit(1);
});
