// Coverage for issue #4881 defect B: unbounded shard-history growth once a
// section's full-replace push (push-section-shard.sh, which increments
// `.shard-deploys` and flattens at SHARD_HISTORY_CAP) stops running in favor
// of push-article-shard-incremental.sh (which deliberately never increments
// that counter). scripts/lib/shard-git-helpers.sh's new
// shard_history_needs_compaction() measures real commit count instead of the
// frozen proxy counter — this is the actual novel logic for the fix, tested
// here against real temp git fixtures (not just regex), same convention as
// tests/shard-git-helpers.test.ts.
//
// scripts/lib/compact-article-shard-history.sh itself (the CLI wrapper) is
// NOT invoked end-to-end here: it hardcodes a git@github.com: SSH remote
// (same as push-section-shard.sh / push-article-shard-incremental.sh, which
// are likewise only structurally tested in this repo, never run end-to-end
// in CI) — so it gets structural/regex coverage below, same convention as
// tests/shard-safety-rails.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');
const HELPERS = join(process.cwd(), 'scripts/lib/shard-git-helpers.sh');

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runHelperScript(statements: string): string {
  return execSync(
    `bash -c 'set -uo pipefail; source "${HELPERS}"; ${statements}'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 },
  ).trim();
}

function gitIdentity(dir: string) {
  sh(`git -C "${dir}" config user.email test@example.com`);
  sh(`git -C "${dir}" config user.name "Test User"`);
}

function seedRepoWithCommits(root: string, name: string, nCommits: number): string {
  const bare = join(root, `${name}-remote.git`);
  sh(`git init -q --bare -b main "${bare}"`);
  const seed = join(root, `${name}-seed`);
  sh(`mkdir -p "${seed}"`);
  sh('git init -q -b main', seed);
  gitIdentity(seed);
  for (let i = 1; i <= nCommits; i++) {
    writeFileSync(join(seed, `v${i}.txt`), `version ${i}`);
    sh('git add -A', seed);
    sh(`git commit -qm "commit ${i}"`, seed);
  }
  if (nCommits > 0) {
    sh(`git push -q "${bare}" main`, seed);
  }
  return bare;
}

describe('shard_history_needs_compaction (runtime, temp git fixtures)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'compact-history-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prints the count and returns 1 (no compaction needed) when below the cap', () => {
    const bare = seedRepoWithCommits(root, 'below-cap', 3);
    const clone = join(root, 'below-cap-clone');
    sh(`git clone -q --filter=blob:none --no-checkout "${bare}" "${clone}"`);

    let rc = 0;
    let out = '';
    try {
      out = runHelperScript(`shard_history_needs_compaction "${clone}" 10`);
    } catch (e: any) {
      rc = e.status;
      out = String(e.stdout).trim();
    }
    expect(out).toBe('3');
    expect(rc).toBe(1);
  });

  it('prints the count and returns 0 (needs compaction) when at or above the cap', () => {
    const bare = seedRepoWithCommits(root, 'at-cap', 5);
    const clone = join(root, 'at-cap-clone');
    sh(`git clone -q --filter=blob:none --no-checkout "${bare}" "${clone}"`);

    const out = runHelperScript(`shard_history_needs_compaction "${clone}" 5`);
    expect(out).toBe('5');
  });

  it('prints "0" and returns 2 (nothing to compact) when HEAD has no commits', () => {
    const emptyBare = join(root, 'empty-remote.git');
    sh(`git init -q --bare -b main "${emptyBare}"`);
    const clone = join(root, 'empty-clone');
    // An empty bare remote has no `main` ref to clone — mirror the shape
    // shard_history_needs_compaction actually guards against (HEAD unborn),
    // same as shard_orphan_init's own zero-commit fixture.
    sh(`git init -q -b main "${clone}"`);

    let rc = 0;
    let out = '';
    try {
      out = runHelperScript(`shard_history_needs_compaction "${clone}" 10`);
    } catch (e: any) {
      rc = e.status;
      out = String(e.stdout).trim();
    }
    expect(out).toBe('0');
    expect(rc).toBe(2);
  });

  it('end-to-end: cap reached -> flatten collapses history to 1 commit (mirrors compact-article-shard-history.sh)', () => {
    const bare = seedRepoWithCommits(root, 'e2e', 4);
    const probeClone = join(root, 'e2e-probe-clone');
    sh(`git clone -q --filter=blob:none --no-checkout "${bare}" "${probeClone}"`);

    // Step 1: the probe clone confirms compaction is due, exactly as
    // compact-article-shard-history.sh's subshell does before re-cloning
    // with a full checkout.
    const rc = (() => {
      try {
        runHelperScript(`shard_history_needs_compaction "${probeClone}" 4`);
        return 0;
      } catch (e: any) {
        return e.status;
      }
    })();
    expect(rc).toBe(0);

    // Step 2: full checkout clone + flatten via the SAME shared helper
    // push-section-shard.sh / push-locale-shard.sh already use.
    const fullClone = join(root, 'e2e-full-clone');
    sh(`git clone -q "${bare}" "${fullClone}"`);
    runHelperScript(
      `shard_orphan_flatten_and_push "${fullClone}" "${bare}" "compaction e2e test" "e2e-label"`,
    );

    const verify = join(root, 'e2e-verify');
    sh(`git clone -q "${bare}" "${verify}"`);
    expect(sh(`git -C "${verify}" rev-list --count HEAD`)).toBe('1');
    expect(sh(`cat "${join(verify, '.shard-deploys')}"`)).toBe('1');
    // The 4 seeded v1..v4.txt files must survive the flatten (it re-adds
    // whatever's on disk, it doesn't drop content — only history).
    expect(existsSync(join(verify, 'v4.txt'))).toBe(true);
  });
});

describe('compact-article-shard-history.sh — structural invariants (issue #4881 defect B)', () => {
  const script = read('scripts/lib/compact-article-shard-history.sh');
  const liveCode = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('sources the shared shard-git-helpers.sh (no duplicated orphan-flatten logic, AGENTS.md #6)', () => {
    expect(script).toMatch(/source\s+"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/shard-git-helpers\.sh"/);
  });

  it('uses a separate, higher, documented cap — never reuses push-section-shard.sh\'s SHARD_HISTORY_CAP=50', () => {
    expect(script).toMatch(/ARTICLE_SHARD_HISTORY_CAP="\$\{ARTICLE_SHARD_HISTORY_CAP:-500\}"/);
    // "$SHARD_HISTORY_CAP" (leading $, no ARTICLE_ prefix) would be the
    // OTHER script's env var — distinct from "$ARTICLE_SHARD_HISTORY_CAP",
    // which legitimately contains "SHARD_HISTORY_CAP" as a substring.
    expect(liveCode).not.toContain('$SHARD_HISTORY_CAP');
  });

  it('delegates the cap decision and the flatten to the shared helpers, not a hand-rolled rev-list check', () => {
    expect(script).toMatch(/shard_history_needs_compaction\s+"\$stage"\s+"\$ARTICLE_SHARD_HISTORY_CAP"/);
    expect(script).toMatch(/shard_orphan_flatten_and_push\s+"\$stage"\s+"\$SHARD_REPO"/);
  });

  it('guards the cap-check assignment against set -e (the same latent-bug class as defect A/B elsewhere)', () => {
    const idx = script.indexOf('n_commits="$(shard_history_needs_compaction');
    expect(idx).toBeGreaterThan(-1);
    const lineEnd = script.indexOf('\n', idx);
    const line = script.slice(idx, lineEnd === -1 ? undefined : lineEnd);
    expect(line).toMatch(/\|\|\s*cap_rc=\$\?/);
  });

  /**
   * The body of a `then` branch, delimited STRUCTURALLY: from the guard line to
   * the first `else`/`fi` at the guard's OWN indentation, so a nested block's
   * deeper-indented closer cannot end the window early.
   *
   * Replaces a `script.slice(idx, idx + 200)`. That window was not wrong, it was
   * FRAGILE: `exit 0` sat at offset 119 of 200, a margin of 75 characters. One
   * extra comment line inside the guard — or a slightly longer `echo` — pushed
   * the match past the end and turned this test red WITHOUT the script's
   * behaviour changing at all. Same class as the 700-byte window repaired in
   * tests/rehydrate-section-shards.test.ts in this PR (margin there: 52), and
   * the reason that one was fixed applies here unchanged.
   *
   * The invariant is not "exit 0 appears within N bytes of the guard". It is
   * "the not-provisioned guard exits instead of falling through", and that is
   * what this expresses.
   */
  function thenBranchOf(src: string, guardRx: RegExp): string {
    const lines = src.split('\n');
    const guardIdx = lines.findIndex((l) => guardRx.test(l));
    expect(guardIdx, `guard ${guardRx} not found`).toBeGreaterThan(-1);
    const indent = lines[guardIdx].match(/^\s*/)![0];
    const closerRx = new RegExp(`^${indent}(?:else|elif|fi)\\b`);
    let endIdx = -1;
    for (let i = guardIdx + 1; i < lines.length; i += 1) {
      if (closerRx.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    expect(endIdx, `guard ${guardRx} never closes at its own indentation`).toBeGreaterThan(guardIdx);
    return lines.slice(guardIdx + 1, endIdx).join('\n');
  }

  const KEY_GUARD_RX = /^\s*if \[ -z "\$key_val" \]; then\s*$/;

  it('skips silently (exit 0) when the deploy key secret is not provisioned, matching both sibling scripts', () => {
    expect(script).toMatch(/key_var="SHARD_\$\{SECTION_UPPER\}_\$\{LOC_UPPER\}_DEPLOY_KEY"/);
    expect(thenBranchOf(script, KEY_GUARD_RX)).toMatch(/exit 0/);
  });

  it('the not-provisioned guard window is bounded by structure, not by a byte count', () => {
    // Pins the fix above. Injecting a long comment inside the guard changes no
    // behaviour, so the assertion must survive it. Under the old
    // `slice(idx, idx + 200)` this padding pushed `exit 0` out of the window
    // (it sat at offset 119 of 200 — a 75-character margin) and the test went
    // red on a comment.
    const lines = script.split('\n');
    const guardIdx = lines.findIndex((l) => KEY_GUARD_RX.test(l));
    expect(guardIdx).toBeGreaterThan(-1);
    const padded = [
      ...lines.slice(0, guardIdx + 1),
      ...Array.from({ length: 12 }, (_, i) => `  # padding comment line ${i} that changes no behaviour whatsoever`),
      ...lines.slice(guardIdx + 1),
    ].join('\n');

    // The byte window this replaced would now MISS it — that is the bug.
    const padIdx = padded.indexOf('if [ -z "$key_val" ]; then');
    expect(padded.slice(padIdx, padIdx + 200).includes('exit 0')).toBe(false);

    // The structural window still finds it.
    expect(thenBranchOf(padded, KEY_GUARD_RX)).toMatch(/exit 0/);
  });

  it('cleans up its keyfile and staging dir via an EXIT trap (incident #4734 class)', () => {
    expect(script).toMatch(/trap\s+'rm -rf "\$stage".*rm -f "\$keyfile".*'\s+EXIT/);
  });

  it('never fetches the previous state via curl/raw.githubusercontent.com (same class as defect A)', () => {
    expect(liveCode).not.toContain('curl');
    expect(liveCode).not.toContain('raw.githubusercontent.com');
  });

  it('never introduces a working-tree file check on a --no-checkout clone (same class as defect A/B)', () => {
    expect(script).not.toMatch(/\[\s+-f\s+"\$stage\//);
  });
});
