// Coverage for scripts/lib/rehydrate-locale-shards.sh's cross-job clone
// cache (issue #4881 defect C, extended from the sibling fix already shipped
// in rehydrate-section-shards.sh / tests/rehydrate-section-shards.test.ts).
//
// Both scripts run inside the SAME post-deploy-validate-dist.yml step
// ("Rehydrate locale then section shards into dist/"), which already exports
// SHARD_CLONE_CACHE_DIR into the step env for the section-shard cache — that
// var was previously inert for rehydrate-locale-shards.sh since nothing read
// it there. This was caught by a manual grep sweep (not the automated
// scripts/ci/check-sibling-patterns.mjs heuristic, which found no lexical
// token overlap since SHARD_CLONE_CACHE_DIR was a brand-new symbol) — kept
// here as a structural regression check.
//
// Same convention as tests/rehydrate-section-shards.test.ts: the script
// itself is not sourced/invoked end-to-end (its non-cache path clones real
// github.com URLs), so this asserts structural invariants on the live source
// text instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

describe('rehydrate-locale-shards.sh — cross-job clone cache (issue #4881 defect C, extended)', () => {
  const script = read('scripts/lib/rehydrate-locale-shards.sh');

  it('checks the cross-job clone cache BEFORE the network clone, with a continue on hit', () => {
    const cacheIdx = script.indexOf('SHARD_CLONE_CACHE_DIR');
    const cloneIdx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeLessThan(cloneIdx);
    const cacheBlock = script.slice(cacheIdx, cloneIdx);
    expect(cacheBlock).toContain('continue');
  });

  it('uses a locale-scoped cache key ("locale-$loc"), never colliding with the section cache under the same SHARD_CLONE_CACHE_DIR', () => {
    expect(script).toMatch(/SHARD_CLONE_CACHE_DIR\/locale-\$loc\/\$loc/);
  });

  it('populates the cross-job cache only after a verified successful clone+copy, guarded so a cache-write failure cannot abort the script', () => {
    const idx = script.indexOf('echo "rehydrated $loc: $(find "dist/$loc" -type f | wc -l) files"');
    expect(idx).toBeGreaterThan(-1);
    const block = script.slice(idx, idx + 400);
    expect(block).toContain('SHARD_CLONE_CACHE_DIR');
    expect(block).toMatch(/\|\|\s*true/);
  });

  it('does not touch the fail-hard posture on a cache miss (unchanged: exit 1 on clone failure / missing subtree)', () => {
    // This script's OWN existing hardening (issues #3772..#4828, #4730) is
    // deliberately fail-hard, unlike rehydrate-section-shards.sh's fail-soft
    // posture — the cache addition must not change that class of behavior,
    // only add a new early-exit path on a cache HIT.
    expect(script).toMatch(/::error::shard \$loc git clone failed after retry/);
    expect(script).toMatch(/::error::shard \$loc has no \$loc\/ subtree/);
    const errorLines = script.match(/::error::[^\n]*/g) ?? [];
    expect(errorLines.length).toBeGreaterThanOrEqual(2);
  });

  it('never uses --filter=blob:none / --no-checkout (this script only ever does full clones, so its existing `[ -f "$tmp/$loc.html" ]` check is legitimate, not the defect-A/B always-false pattern)', () => {
    expect(script).not.toMatch(/--filter=blob:none/);
    expect(script).not.toMatch(/--no-checkout/);
  });
});
