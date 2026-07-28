// Coverage for scripts/lib/rehydrate-section-shards.sh's git-clone fallback
// (issue #4881 defect C). The script itself is not sourced/invoked directly
// here: its bottom-level loop reads the real scripts/lib/section-shard-slugs.json
// and clones real github.com URLs, which isn't something a unit test should
// depend on (network, credentials, flakiness). Instead this file:
//   1. Proves, against a real local git fixture, the reason the fix does NOT
//      add partial-clone + cone sparse-checkout: cone mode always
//      materializes every root-level file regardless of the directory
//      pattern, and this repo's only non-$sub content IS root-level scaffold
//      files, so sparse-checkout would fetch byte-for-byte the same tree a
//      plain clone does. This was the planned fix until this exact test
//      disproved it — kept as a regression check so nobody re-adds it later
//      expecting a saving that measurably isn't there.
//   2. Asserts the structural invariants of the actual fix that shipped: a
//      cross-job clone cache short-circuit before the (unchanged) network
//      clone, ordered correctly, with the unchanged fail-soft posture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cone sparse-checkout vs a shard repo shape (why the fix does NOT use it)', () => {
  let root: string;
  let bare: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rehydrate-section-'));
    bare = join(root, 'shard-remote.git');
    sh(`git init -q --bare -b main "${bare}"`);

    // Seed a repo shaped exactly like a real frontaliere-<section>-<loc>
    // shard: scaffold files at root + the section's content at a nested
    // locale path (the en/de/fr shape: sub = "en/find-jobs-ticino").
    const seed = join(root, 'seed');
    sh(`mkdir -p "${seed}/en/find-jobs-ticino/some-job"`);
    writeFileSync(join(seed, '.nojekyll'), '');
    writeFileSync(join(seed, 'CNAME'), 'origin-ticino-en.frontaliereticino.ch');
    writeFileSync(join(seed, 'index.html'), '<html>placeholder</html>');
    writeFileSync(join(seed, '.shard-filecount'), '1');
    writeFileSync(join(seed, '.shard-deploys'), '1');
    writeFileSync(join(seed, 'en/find-jobs-ticino/index.html'), '<html>section index</html>');
    writeFileSync(join(seed, 'en/find-jobs-ticino/some-job/index.html'), '<html>job page</html>');
    sh('git init -q -b main', seed);
    sh(`git -C "${seed}" config user.email test@example.com`);
    sh(`git -C "${seed}" config user.name "Test User"`);
    sh('git add -A', seed);
    sh('git commit -qm seed', seed);
    sh(`git push -q "${bare}" main`, seed);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cone sparse-checkout of $sub still materializes root-level scaffold files', () => {
    const tmp = join(root, 'clone-target');
    const sub = 'en/find-jobs-ticino';

    sh(`git clone -q --depth 1 --filter=blob:none --no-checkout --single-branch --branch main "${bare}" "${tmp}"`);
    sh(`git -C "${tmp}" sparse-checkout set --cone "${sub}"`);
    sh(`git -C "${tmp}" checkout -q main`);

    // The subtree we actually want IS present...
    expect(existsSync(join(tmp, sub, 'index.html'))).toBe(true);
    expect(existsSync(join(tmp, sub, 'some-job', 'index.html'))).toBe(true);
    // ...but so is every root-level scaffold file. Cone mode does not (and,
    // per its documented design, cannot) exclude these — proving there is no
    // byte saving available here versus a plain clone, since this repo has
    // no OTHER sibling directory for sparse-checkout to exclude.
    expect(existsSync(join(tmp, 'CNAME'))).toBe(true);
    expect(existsSync(join(tmp, '.shard-filecount'))).toBe(true);
    expect(existsSync(join(tmp, '.nojekyll'))).toBe(true);
  });
});

describe('rehydrate-section-shards.sh — structural invariants (issue #4881 defect C)', () => {
  const script = read('scripts/lib/rehydrate-section-shards.sh');

  it('checks the cross-job clone cache BEFORE the network clone, with a continue on hit', () => {
    const cacheIdx = script.indexOf('SHARD_CLONE_CACHE_DIR');
    const cloneIdx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeLessThan(cloneIdx);
    const cacheBlock = script.slice(cacheIdx, cloneIdx);
    expect(cacheBlock).toContain('continue');
  });

  it('does NOT use partial clone / sparse-checkout for the network fallback (proven not to help, see the test above)', () => {
    // The rejection is documented in a comment (which legitimately mentions
    // both strings by name) — check the LIVE code only, same
    // comment-stripping convention as tests/fast-publish-workflow-invariants.test.ts.
    const liveCode = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(liveCode).not.toMatch(/--filter=blob:none/);
    expect(liveCode).not.toMatch(/sparse-checkout/);
  });

  it('populates the cross-job cache only after a verified successful clone+copy', () => {
    const idx = script.indexOf('git clone --depth 1 --single-branch --branch main');
    const block = script.slice(idx, idx + 700);
    expect(block).toMatch(/if \[ -d "\$tmp\/\$sub" \]/);
    expect(block).toContain('SHARD_CLONE_CACHE_DIR');
  });

  it('preserves the unchanged fail-soft posture: no set -e, warnings + continue on failure', () => {
    // \S* (not .*) so the flags token can't span past the whitespace before
    // "pipefail" — "set -uo pipefail" must NOT match just because
    // "pipefail" contains an 'e'.
    expect(script).not.toMatch(/^\s*set\s+-\S*e\S*\b/m);
    const warningLines = script.match(/::warning::[^\n]*/g) ?? [];
    expect(warningLines.length).toBeGreaterThanOrEqual(2); // clone-failed + no-subtree cases, unchanged
  });

  it('never introduces a working-tree file check on a --no-checkout clone (same class as defect A/B)', () => {
    expect(script).not.toMatch(/\[\s+-f\s+"\$tmp\//);
  });
});
