import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';
import react from '@vitejs/plugin-react';
import path from 'path';
import { shardItems } from './scripts/ci/lpt-shard.mjs';
import shardWeights from './tests/shard-weights.json';

// Custom shard distribution: balance `--shard=i/N` by estimated per-file
// duration (tests/shard-weights.json) via LPT bin-packing instead of vitest's
// default sha1-of-path hash. The hash split balances by file COUNT, so a shard
// that happens to collect two of the heavy synchronous source-scan guards
// (no-inlanguage-on-forbidden-schemas, blog-body-typescript-syntax, …) becomes
// the long pole and pins the gate wall. LPT spreads the heaviest files across
// distinct shards → equal per-shard wall → lower slowest-shard (= gate) time.
// The partition is a deterministic disjoint cover (see scripts/ci/lpt-shard.mjs
// + tests/lpt-shard.test.ts) so every file still runs exactly once across the N
// independent `vitest run --shard=i/N` processes. Falls back to the default
// hash split when not sharding (local full run → `config.shard` undefined).
// Weights are heuristic and refreshable from a CI json-reporter run; the
// partition stays correct (disjoint cover) regardless of weight accuracy.
const DEFAULT_WEIGHT_MS = 500;
class BalancedSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    if (!config.shard) return super.shard(files);
    const root = config.root.replace(/\\/g, '/');
    const relOf = (spec: TestSpecification): string => {
      let p = spec.moduleId.replace(/\\/g, '/');
      if (p.startsWith(root)) p = p.slice(root.length);
      return p.replace(/^\/+/, '');
    };
    const weights = shardWeights as Record<string, number>;
    return shardItems(files, {
      index: config.shard.index,
      count: config.shard.count,
      keyOf: relOf,
      weightOf: (spec: TestSpecification): number => weights[relOf(spec)] ?? DEFAULT_WEIGHT_MS,
    });
  }
}

// ─── Test-environment split (jsdom vs node) ────────────────────────────────
// jsdom environment construction costs ~0.9s/file and, with `isolate: true`,
// is paid PER FILE — it dominated the suite wall (the full run spent ~830s
// cumulative in "environment" alone). The vast majority of the suite is pure
// Node logic (crawler parsers, source-scan guards, data integrity) that never
// touches `document`/`window`, yet paid the jsdom tax for nothing.
//
// So the default environment is `node`, and only the files that actually need
// a DOM run under `jsdom`: every `*.test.tsx` (React component tests) plus the
// explicit `JSDOM_TS_FILES` list below (`.test.ts` files that touch
// document/window/localStorage/@testing-library/etc). `tests/setup.tsx` is
// already node-safe — every DOM access is guarded by `HAS_DOM` — so it runs
// harmlessly in both projects. A meta-guard (tests/test-env-split.test.ts)
// fails if a node-project `.test.ts` references a DOM global, so a newly added
// DOM test can't silently land under `node` and flake: add it here.
//
// NOTE: a per-file `// @vitest-environment node|jsdom` docblock still overrides
// the project assignment (vitest honours the docblock first), so the handful of
// files that already opt in keep working unchanged.
const JSDOM_TS_FILES = [
  'tests/ad-analytics.test.ts',
  'tests/analytics-instrumentation.test.ts',
  'tests/analytics-seo.test.ts',
  'tests/artisa-job-parser.test.ts',
  'tests/authGateExperiment.test.ts',
  'tests/behavior-tracker.test.ts',
  'tests/bot-gate-parity.test.ts',
  'tests/build-plugins/earlyBootSelfHeal.test.ts',
  'tests/build-plugins/logo-fallback-script.test.ts',
  'tests/cdn-image-base.test.ts',
  'tests/dist-salary-hub-footer-portal.test.ts',
  'tests/dom-reconciliation-guard.test.ts',
  'tests/extract-article-text.test.ts',
  'tests/flat-html-redirect.test.ts',
  'tests/fuel-italian-station-redesign.test.ts',
  'tests/fuel-station-redesign.test.ts',
  'tests/functions/error-response.test.ts',
  'tests/gamification.test.ts',
  'tests/hooks/useNavigationState.test.ts',
  'tests/hooks/useNewsletterState.test.ts',
  'tests/hooks/useSimulationState.test.ts',
  'tests/hooks/useUIState.test.ts',
  'tests/hooks/useUserState.test.ts',
  'tests/header-bidding-script-error.test.ts',
  'tests/hospital-html-helpers-css-leak.test.ts',
  'tests/i18n-guard.test.ts',
  'tests/i18n.test.ts',
  'tests/jina-proxy.test.ts',
  'tests/job-detail-seed.test.ts',
  'tests/jobboard-related-search-navigation.test.ts',
  'tests/language-switch.test.ts',
  'tests/linkedin-auth-user-profile.test.ts',
  'tests/locale-router-stale-if-error.test.ts',
  'tests/no-dark-color-classes.test.ts',
  'tests/newsletter-autologin-onetap-suppression.test.ts',
  'tests/newsletter-confirmation.test.ts',
  'tests/newsletter-engagement-ratelimit.test.ts',
  'tests/offerwall-custom-choice.test.ts',
  'tests/offerwall-static-fc-snippet.test.ts',
  'tests/parsers/groupe-mutuel-parser.test.ts',
  'tests/parsers/hes-so-valais-parser.test.ts',
  'tests/pending-job-alert.test.ts',
  'tests/performance-features.test.ts',
  'tests/posthog-error-filter-may18.test.ts',
  'tests/reconcile-followups-decision.test.ts',
  'tests/regression/company-filter-vs-job-slug.test.ts',
  'tests/related-search-clusters.test.ts',
  'tests/resilient-import.test.ts',
  'tests/router.test.ts',
  'tests/seo-html-lang-sync.test.ts',
  'tests/seo-localization.test.ts',
  'tests/seo-noindex-filter-variants.test.ts',
  'tests/seo-static-overlay-hreflang-selfref.test.ts',
  'tests/seo/blog-pagination-bfs.test.ts',
  'tests/seo/cathedral-job-detail-canton.test.ts',
  'tests/seo/cathedral-previous-slug-canton.test.ts',
  'tests/seo/inlanguage-whitelist.test.ts',
  'tests/seo/seo-hubs-pagination-bfs.test.ts',
  'tests/services/benignErrorPatterns.test.ts',
  // analytics.ts exports `fireCalcEntryIfNeeded` only when `window` is defined,
  // so under the node project the import resolves to `undefined` ("not a
  // function"). The test loads the real module via vi.importActual → needs jsdom.
  'tests/services/calc-entry-emitter.test.ts',
  'tests/services/jobDetailAlertGating.test.ts',
  'tests/services/pdf-report.test.ts',
  'tests/services/posthog.test.ts',
  'tests/soft-landing-seo.test.ts',
  'tests/swisscom-crawler.test.ts',
  'tests/switzerland-unemployment-parser.test.ts',
  'tests/technical-improvements.test.ts',
  'tests/trafficScheduler.test.ts',
  'tests/trafficScheduler.webcam-only.test.ts',
  'tests/urlState.test.ts',
  'tests/use-kill-switches.test.ts',
  'tests/useSeoPageTracking.test.ts',
  'tests/userProfile.test.ts',
];

const COMMON_EXCLUDE = ['tests/post-build/**', 'tests/e2e/**'];

// Shared `test` options applied to both the jsdom and node projects. Only
// `name`/`environment`/`include`/`exclude` differ between them.
const sharedTest = {
  globals: true,
  setupFiles: ['./tests/setup.tsx'],
  testTimeout: 15000,
  css: false,
  // Vitest 4 removed the `poolOptions` wrapper — pool tuning flags now live
  // directly on `InlineConfig`. `isolate: true` runs each test file in its
  // own VM context — prevents module-cache pollution between sibling tests.
  // The suite has ~10 tests that pass in isolation but fail when run after
  // a sibling that leaks vi.mock state into the shared context (e.g.
  // errorReporter, useSeoPageTracking, jobboard-*). Cost: ~30% wall time
  // increase, but turns a flaky suite into a deterministic one — required
  // for the suite to actually gate CI without false-positive failures.
  pool: 'threads' as const,
  isolate: true,
  sequence: {
    // Balance shards by estimated duration (LPT) instead of the default
    // count-balanced sha1 hash split — see BalancedSequencer above.
    sequencer: BalancedSequencer,
  },
  server: {
    deps: {
      inline: ['unpdf'],
    },
  },
};

export default defineConfig({
 plugins: [react()],
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 // `@google-cloud/recaptcha-enterprise` is only installed under
 // functions/node_modules, not at the repo root. Tests vi.mock it,
 // but Vite import-analysis runs before mocks → alias to a stub so
 // resolution succeeds and the mock can take over at module-load time.
 '@google-cloud/recaptcha-enterprise': path.resolve(__dirname, 'tests/stubs/recaptcha-enterprise.ts'),
 },
 },
 test: {
 projects: [
 {
 // `extends: true` inherits the root vite config (plugins + `resolve.alias`,
 // notably the `@` → repo-root alias) — projects do NOT inherit it otherwise,
 // and `@/...` imports fail to resolve.
 extends: true,
 test: {
 ...sharedTest,
 name: 'dom',
 environment: 'jsdom',
 include: ['tests/**/*.test.tsx', ...JSDOM_TS_FILES],
 exclude: COMMON_EXCLUDE,
 },
 },
 {
 extends: true,
 test: {
 ...sharedTest,
 name: 'node',
 environment: 'node',
 include: ['tests/**/*.test.ts'],
 exclude: [...COMMON_EXCLUDE, ...JSDOM_TS_FILES],
 },
 },
 ],
 },
});
