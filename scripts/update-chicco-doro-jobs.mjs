#!/usr/bin/env node
/**
 * Dedicated Chicco d'Oro crawler runner.
 *
 * Uses the standard crawler template with the Chicco d'Oro parser.
 * All fetch/parse logic lives in ./lib/chicco-doro-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllChiccoDoroJobs,
  assertCompleteChiccoDoroSnapshot,
  isChiccoDoroJob,
  isTrustedDomain,
  CHICCO_DORO_KEY,
  CHICCO_DORO_COMPANY_NAME,
} from './lib/chicco-doro-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A real vacancy that vanishes from a non-empty batch (the source never
// proves a complete zero — `authoritativeSnapshotScope: 'empty-only'` only
// verifies zero-job snapshots) is NOT retained indefinitely: it still goes
// through the default `retainMissingJobs` grace in mergePreserveLocaleData
// (GRACE_PERIOD_MAX_MISSES = 2 in scripts/lib/dedicated-crawler-common.mjs),
// so a stale row here is retired after at most 2 consecutive misses — see
// "retires a real vacancy that disappears from a non-empty snapshot within a
// bounded number of runs" in tests/chicco-doro-crawler.test.ts.
//
// The same `authoritativeSnapshotScope: 'empty-only'` also means
// `skipShrinkGuard` is false on any non-empty run, so a shrink here goes
// through the URL probe (verifyShrinkAgainstSource) instead of skipping it.
// Live-verified 2026-09-02: chiccodoro.com is WordPress behind Cloudflare,
// and a removed path resolves to a genuine HTTP 404 after redirect-follow
// (not the softer "200 with stale content" some WordPress sites serve), so
// `validateJobUrl`'s definitive-404 check corroborates cleanly — see
// "shrink-guard probe reliability on Chicco detail pages" in
// tests/chicco-doro-crawler.test.ts.
runStandardCrawlerPipeline({
  companyKey: CHICCO_DORO_KEY,
  companyLabel: CHICCO_DORO_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllChiccoDoroJobs,
  isCompanyJob: isChiccoDoroJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
  validateAuthoritativeSnapshot: assertCompleteChiccoDoroSnapshot,
  allowAuthoritativeEmptySnapshot: true,
  authoritativeSnapshotScope: 'empty-only',
}).catch((err) => {
  console.error(`❌ Chicco d'Oro crawler failed: ${err?.message || err}`);
  process.exit(1);
});
