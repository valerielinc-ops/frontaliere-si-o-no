// Runtime (not just regex) coverage for scripts/lib/shard-git-helpers.sh
// (issue #4881, defects A/B). The bug these helpers fix was NOT visible to a
// regex-on-source-text assertion: `[ -f "$stage/.shard-deploys" ]` reads as
// perfectly reasonable bash, but is ALWAYS false against a
// `git clone --filter=blob:none --no-checkout` clone, because --no-checkout
// never materializes ANY working-tree file (see `git help clone`). Only
// actually running the helper against a real blobless clone proves the fix —
// see the first `describe` block below, which is the direct regression test
// for that latent defect.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPERS = join(process.cwd(), 'scripts/lib/shard-git-helpers.sh');

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Runs one or more statements with shard-git-helpers.sh sourced. Statements
// may reference any of its functions directly.
function runHelperScript(statements: string, timeoutMs = 10_000): string {
  return execSync(
    `bash -c 'set -uo pipefail; source "${HELPERS}"; ${statements}'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs },
  ).trim();
}

function gitIdentity(dir: string) {
  sh(`git -C "${dir}" config user.email test@example.com`);
  sh(`git -C "${dir}" config user.name "Test User"`);
}

describe('shard-git-helpers.sh (runtime, temp git fixtures)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shard-git-helpers-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('shard_read_counter', () => {
    // This is the direct regression test for the latent defect: both
    // push-section-shard.sh and push-locale-shard.sh read their bookkeeping
    // counters from a --no-checkout clone via `[ -f "$stage/.shard-deploys" ]`
    // — always false — so dcount/prev_n were always read as 0.
    let bare: string;
    let clone: string;

    beforeAll(() => {
      bare = join(root, 'counter-remote.git');
      sh(`git init -q --bare -b main "${bare}"`);

      const seed = join(root, 'counter-seed');
      sh(`mkdir -p "${seed}"`);
      writeFileSync(join(seed, 'index.html'), '<html>seed</html>');
      writeFileSync(join(seed, '.shard-deploys'), '3');
      writeFileSync(join(seed, '.shard-filecount'), '7');
      sh('git init -q -b main', seed);
      gitIdentity(seed);
      sh('git add -A', seed);
      sh('git commit -qm seed', seed);
      sh(`git push -q "${bare}" main`, seed);

      clone = join(root, 'counter-clone');
      sh(`git clone -q --depth 1 --filter=blob:none --no-checkout "${bare}" "${clone}"`);
    });

    it('clone under --no-checkout materializes NO working-tree file', () => {
      // Confirms the premise of the bug: a bare `[ -f ... ]` check against
      // this clone can never see the counter file.
      expect(existsSync(join(clone, '.shard-deploys'))).toBe(false);
      expect(existsSync(join(clone, 'index.html'))).toBe(false);
    });

    it('reads .shard-deploys via git-plumbing regardless of missing checkout', () => {
      const val = runHelperScript(`shard_read_counter "${clone}" .shard-deploys`);
      expect(val).toBe('3');
    });

    it('reads .shard-filecount via git-plumbing regardless of missing checkout', () => {
      const val = runHelperScript(`shard_read_counter "${clone}" .shard-filecount`);
      expect(val).toBe('7');
    });

    it('defaults to 0 for a path absent at HEAD', () => {
      const val = runHelperScript(`shard_read_counter "${clone}" .does-not-exist`);
      expect(val).toBe('0');
    });

    it('defaults to 0 for a clone with no commits yet (first push)', () => {
      const emptyBare = join(root, 'counter-empty-remote.git');
      sh(`git init -q --bare -b main "${emptyBare}"`);
      const emptyClone = join(root, 'counter-empty-clone');
      // No prior commit exists — this mirrors push-section-shard.sh's
      // "no prior clone (first push / transient)" branch, where the clone
      // itself fails and prev_n/dcount stay at their 0 default. Exercise the
      // function directly against a repo with zero commits (HEAD unresolved).
      sh(`git init -q -b main "${emptyClone}"`);
      const val = runHelperScript(`shard_read_counter "${emptyClone}" .shard-deploys`);
      expect(val).toBe('0');
    });
  });

  describe('shard_orphan_init', () => {
    it('creates a fresh repo on branch main with zero commits', () => {
      const dir = join(root, 'orphan-init-target');
      sh(`mkdir -p "${dir}"`);
      runHelperScript(`shard_orphan_init "${dir}"`);
      // symbolic-ref (not rev-parse --abbrev-ref) is the correct probe here:
      // HEAD is an unborn branch (no commit yet), and `rev-parse --abbrev-ref
      // HEAD` fails to resolve an unborn HEAD ("ambiguous argument 'HEAD'").
      expect(sh(`git -C "${dir}" symbolic-ref --short HEAD`)).toBe('main');
      expect(() => sh(`git -C "${dir}" rev-parse HEAD`)).toThrow();
    });
  });

  describe('shard_orphan_flatten_and_push', () => {
    let bare: string;

    beforeAll(() => {
      bare = join(root, 'flatten-remote.git');
      sh(`git init -q --bare -b main "${bare}"`);

      // Seed the remote with 3 separate commits so the test can prove the
      // flatten genuinely collapses history to 1, not merely that a push
      // succeeds.
      const seed = join(root, 'flatten-seed');
      sh(`mkdir -p "${seed}"`);
      sh('git init -q -b main', seed);
      gitIdentity(seed);
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(seed, `v${i}.txt`), `version ${i}`);
        sh('git add -A', seed);
        sh(`git commit -qm "commit ${i}"`, seed);
      }
      sh(`git push -q "${bare}" main`, seed);
      expect(sh(`git ls-remote "${bare}" main`)).not.toBe('');
    });

    it('flattens to a single orphan commit, resets .shard-deploys to 1, and pushes the staged content', () => {
      const stage = join(root, 'flatten-stage');
      sh(`mkdir -p "${stage}"`);
      writeFileSync(join(stage, 'page.html'), '<html>final content</html>');

      const rc = runHelperScript(
        `shard_orphan_flatten_and_push "${stage}" "${bare}" "flatten test commit" "test-label"; echo $?`,
      );
      expect(rc).toBe('0');

      const verify = join(root, 'flatten-verify');
      sh(`git clone -q "${bare}" "${verify}"`);
      expect(sh(`git -C "${verify}" rev-list --count HEAD`)).toBe('1');
      expect(sh(`cat "${join(verify, '.shard-deploys')}"`)).toBe('1');
      expect(sh(`cat "${join(verify, 'page.html')}"`)).toBe('<html>final content</html>');
      // The pre-existing v1/v2/v3.txt files from the seeded history must be
      // GONE — a real flatten replaces the tree, it doesn't merge onto it.
      expect(existsSync(join(verify, 'v1.txt'))).toBe(false);
    });
  });

  describe('shard_push_with_retry', () => {
    it('succeeds immediately against a reachable repo (no retry needed)', () => {
      const bare = join(root, 'retry-ok-remote.git');
      sh(`git init -q --bare -b main "${bare}"`);
      const stage = join(root, 'retry-ok-stage');
      sh(`mkdir -p "${stage}"`);
      sh('git init -q -b main', stage);
      gitIdentity(stage);
      writeFileSync(join(stage, 'f.txt'), 'ok');
      sh('git add -A', stage);
      sh('git commit -qm ok', stage);

      const rc = runHelperScript(
        `shard_push_with_retry "${stage}" "${bare}" main test-label; echo $?`,
      );
      expect(rc).toBe('0');
    });

    it('retries 3 times with backoff then reports failure against an unreachable repo', () => {
      const stage = join(root, 'retry-fail-stage');
      sh(`mkdir -p "${stage}"`);
      sh('git init -q -b main', stage);
      gitIdentity(stage);
      writeFileSync(join(stage, 'f.txt'), 'x');
      sh('git add -A', stage);
      sh('git commit -qm x', stage);

      // 5s + 10s backoff between the 3 attempts is intentional (mirrors the
      // production retry cadence unchanged) — this single test genuinely
      // takes >=15s wall-clock, accepted for real (not inferred) proof the
      // loop runs all 3 attempts and returns non-zero.
      const out = execSync(
        `bash -c 'set -uo pipefail; source "${HELPERS}"; ` +
          `shard_push_with_retry "${stage}" "/nonexistent/path/repo.git" main unreachable-label; echo "RC=$?"'`,
        { encoding: 'utf8', timeout: 25_000 },
      );
      expect(out).toMatch(/push attempt 1\/3 failed/);
      expect(out).toMatch(/push attempt 2\/3 failed/);
      expect(out).not.toMatch(/push attempt 3\/3 failed/); // no retry logged after the last attempt
      expect(out).toContain('RC=1');
    }, 30_000);
  });
});
