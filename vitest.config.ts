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
 globals: true,
 environment: 'jsdom',
 setupFiles: ['./tests/setup.tsx'],
 include: ['tests/**/*.test.{ts,tsx}'],
 exclude: ['tests/post-build/**', 'tests/e2e/**'],
 testTimeout: 15000,
 css: false,
 pool: 'threads',
 // Vitest 4 removed the `poolOptions` wrapper — pool tuning flags now live
 // directly on `InlineConfig`. `isolate: true` runs each test file in its
 // own VM context — prevents module-cache pollution between sibling tests.
 // The suite has ~10 tests that pass in isolation but fail when run after
 // a sibling that leaks vi.mock state into the shared context (e.g.
 // errorReporter, useSeoPageTracking, jobboard-*). Cost: ~30% wall time
 // increase, but turns a flaky suite into a deterministic one — required
 // for the suite to actually gate CI without false-positive failures.
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
 },
});
