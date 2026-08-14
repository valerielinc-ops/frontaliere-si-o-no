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

  /**
   * The body of the post-clone `if [ -n "${SHARD_CLONE_CACHE_DIR:-}" ]; then`
   * cache-write guard, delimited STRUCTURALLY: from the guard line to the
   * first `else`/`fi` at the guard's OWN indentation, so a nested block's
   * deeper-indented closer cannot end the window early. The regex is
   * specific enough (`; then` with no `&&`) to only match this write guard,
   * not the earlier cache-HIT read guard (`if [ -n ... ] && [ -d ... ]; then`).
   *
   * This used to be `script.slice(idx, idx + 400)` from the "rehydrated
   * $loc: ..." echo anchor. That window was measured at 117 chars to
   * `SHARD_CLONE_CACHE_DIR` (margin 283) and 300 chars to `|| true` (margin
   * 100, i.e. ~2 extra comment lines) — same fragile-window class as the
   * 700-byte window repaired in tests/rehydrate-section-shards.test.ts and
   * the 200-byte one in tests/compact-article-shard-history.test.ts in this
   * same PR (#5369 §8).
   */
  function cacheWriteGuardBody(): string {
    const lines = script.split('\n');
    const guardRx = /^\s*if \[ -n "\$\{SHARD_CLONE_CACHE_DIR:-\}" \]; then\s*$/;
    const guardIdx = lines.findIndex((l) => guardRx.test(l));
    expect(guardIdx, 'post-clone SHARD_CLONE_CACHE_DIR write guard not found').toBeGreaterThan(-1);
    const indent = lines[guardIdx].match(/^\s*/)![0];
    const closerRx = new RegExp(`^${indent}(?:else|fi)\\b`);
    let endIdx = -1;
    for (let i = guardIdx + 1; i < lines.length; i += 1) {
      if (closerRx.test(lines[i])) { endIdx = i; break; }
    }
    expect(endIdx, 'cache-write guard never closes at its own indentation').toBeGreaterThan(guardIdx);
    return lines.slice(guardIdx + 1, endIdx).join('\n');
  }

  it('populates the cross-job cache only after a verified successful clone+copy, guarded so a cache-write failure cannot abort the script', () => {
    const body = cacheWriteGuardBody();
    expect(body).toContain('SHARD_CLONE_CACHE_DIR');
    expect(body).toMatch(/\|\|\s*true/);
  });

  it('the cache-write guard window is bounded by structure, not by a byte count', () => {
    // Pins the fix above: prepending a long comment inside the guard must not
    // change what the window contains. Simulated on a copy of the script so
    // the real file is untouched — the previous 400-char slice failed this.
    const lines = script.split('\n');
    const guardRx = /^\s*if \[ -n "\$\{SHARD_CLONE_CACHE_DIR:-\}" \]; then\s*$/;
    const guardIdx = lines.findIndex((l) => guardRx.test(l));
    const echoIdx = lines.findIndex((l) => l.includes('echo "rehydrated $loc: $(find "dist/$loc" -type f | wc -l) files"'));
    const padded = [
      ...lines.slice(0, guardIdx),
      ...Array.from({ length: 8 }, (_, n) => `      # padding comment ${n} — behaviour unchanged`),
      ...lines.slice(guardIdx),
    ].join('\n');
    const echoOffset = padded.indexOf('echo "rehydrated $loc: $(find "dist/$loc" -type f | wc -l) files"');
    expect(echoIdx).toBeGreaterThan(-1);
    expect(
      padded.slice(echoOffset, echoOffset + 400).includes('|| true'),
      'a fixed 400-char window loses the cache-write assertion to a handful of comment lines',
    ).toBe(false);
    // …while the structural bound still finds it.
    const pLines = padded.split('\n');
    const pGuardIdx = pLines.findIndex((l) => guardRx.test(l));
    const indent = pLines[pGuardIdx].match(/^\s*/)![0];
    const closerRx = new RegExp(`^${indent}(?:else|fi)\\b`);
    let pEnd = -1;
    for (let i = pGuardIdx + 1; i < pLines.length; i += 1) {
      if (closerRx.test(pLines[i])) { pEnd = i; break; }
    }
    expect(pLines.slice(pGuardIdx + 1, pEnd).join('\n')).toMatch(/\|\|\s*true/);
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
