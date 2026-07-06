/**
 * Regression lock for follow-up issue #3617 (adversarial-check item on
 * PR #3613): "Verify `resolve_append_conflicts` is idempotent across
 * multiple rebase-retry cycles in the same push."
 *
 * `scripts/lib/git-push-with-retry.sh`'s retry loop can, in the worst case,
 * hit a rebase conflict on more than one loop iteration within the same
 * push (a fresh concurrent commit lands on `origin` again while we were
 * resolving/pushing the previous conflict). Each conflicting iteration
 * re-invokes `resolve_append_conflicts` (via `--in-place-resolver-cmd`)
 * against the CURRENT rebase, so the open question was whether repeated
 * invocation across cycles could duplicate/accumulate content instead of
 * cleanly converging.
 *
 * This test drives the REAL `scripts/lib/resolve-append-conflicts.sh`
 * (sourced, unmodified) through two SEQUENTIAL rebase-conflict cycles
 * against a real temp git repo — simulating loop iteration N (resolve,
 * `rebase --continue`) followed by loop iteration N+1 hitting a NEW
 * conflict from a second concurrent writer — and asserts the final,
 * pushed state contains every contributed id exactly once with a single
 * surviving `ALL_BLOG_ARTICLE_IDS` declaration.
 *
 * Finding: no bug. Each rebase cycle's diff is computed relative to the
 * immediately-preceding (already-resolved) commit, not replayed from the
 * push's original starting point, so a later cycle only ever reconciles
 * genuinely NEW conflicting content — it never re-processes a hunk an
 * earlier cycle already resolved. The `ALL_BLOG_ARTICLE_IDS` merge itself
 * also de-dupes via a `Set`, so even if the same id were seen twice it
 * would not be duplicated in the output. This test locks that behavior.
 *
 * Environment note: `resolve-append-conflicts.sh` calls `sed -i 'EXPR' file`
 * (the GNU form — no space-less suffix). BSD sed (macOS, used by local dev)
 * requires the backup-suffix argument even when empty (`-i ''`), so the
 * unmodified script's sed calls fail silently on macOS. Rather than patch
 * the production script (out of scope for this issue, and CI always runs
 * on Linux/GNU sed), the tests below prepend a tiny PATH-only `sed` shim
 * that normalizes just that one call shape when the system `sed` is BSD —
 * it is inert on Linux (GNU sed already accepts the unmodified call).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOLVER_SCRIPT = path.join(ROOT, 'scripts', 'lib', 'resolve-append-conflicts.sh');

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates the PATH-only BSD/GNU `sed -i` normalizing shim (see file header). */
function makeSedShimDir(): string {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'sed-shim-'));
  const shimPath = path.join(shimDir, 'sed');
  writeFileSync(
    shimPath,
    [
      '#!/usr/bin/env bash',
      '# Test-only shim: normalize `sed -i EXPR file` (GNU form, no suffix) so it',
      "# also works under BSD sed, which requires the (possibly empty) in-place",
      '# backup-suffix argument. Inert on Linux/GNU sed (the common case in CI).',
      'if [ "$1" = "-i" ] && ! /usr/bin/sed --version >/dev/null 2>&1; then',
      '  shift',
      "  exec /usr/bin/sed -i '' \"$@\"",
      'fi',
      'exec /usr/bin/sed "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(shimPath, 0o755);
  return shimDir;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function initRepoUser(cwd: string): void {
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test Writer'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
}

/** Runs `source resolve-append-conflicts.sh && resolve_append_conflicts` for real. */
function runResolver(cwd: string, pathWithShim: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', ['-c', `source '${RESOLVER_SCRIPT}' && resolve_append_conflicts`], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${pathWithShim}:${process.env.PATH}` },
    });
    return { status: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function continueRebase(cwd: string): void {
  execFileSync('git', ['rebase', '--continue'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_EDITOR: ':' },
  });
}

const ROUTER_FIXTURE_BASE = ["export type BlogArticleId = string;", "export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = ['base-1'];", ""].join(
  '\n',
);

function withIds(ids: string[]): string {
  return [
    'export type BlogArticleId = string;',
    `export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = [${ids.map((id) => `'${id}'`).join(', ')}];`,
    '',
  ].join('\n');
}

describe('resolve_append_conflicts — no-op guard when nothing is conflicted', () => {
  it('returns success without touching the tree on a clean repo (early-return guard)', () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), 'resolve-conflicts-clean-'));
    cleanupDirs.push(repoDir);
    git(['init', '-q', '-b', 'main'], repoDir);
    initRepoUser(repoDir);
    writeFileSync(path.join(repoDir, 'router.ts'), ROUTER_FIXTURE_BASE);
    git(['add', '-A'], repoDir);
    git(['commit', '-q', '-m', 'base'], repoDir);

    const shimDir = makeSedShimDir();
    cleanupDirs.push(shimDir);
    const { status, output } = runResolver(repoDir, shimDir);

    expect(status).toBe(0);
    // The function returns immediately (no "Auto-resolving..." banner) when
    // `git diff --name-only --diff-filter=U` finds nothing unmerged.
    expect(output).not.toMatch(/Auto-resolving conflicts/);
    expect(readFileSync(path.join(repoDir, 'router.ts'), 'utf-8')).toBe(ROUTER_FIXTURE_BASE);
  });
});

describe('resolve_append_conflicts — idempotency across two sequential rebase-retry cycles', () => {
  it('does not duplicate ids when the SAME push survives two separate conflicting rebase cycles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'resolve-conflicts-multicycle-'));
    cleanupDirs.push(root);
    const shimDir = makeSedShimDir();
    cleanupDirs.push(shimDir);

    // --- origin (bare) ---
    const originDir = path.join(root, 'origin.git');
    mkdirSync(originDir);
    git(['init', '-q', '--bare'], originDir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], originDir);

    // --- local: the "article generator" checkout with the commit to push ---
    const localDir = path.join(root, 'local');
    git(['clone', '-q', originDir, localDir], root);
    initRepoUser(localDir);
    writeFileSync(path.join(localDir, 'router.ts'), ROUTER_FIXTURE_BASE);
    git(['add', '-A'], localDir);
    git(['commit', '-q', '-m', 'base'], localDir);
    git(['push', '-q', 'origin', 'main'], localDir);

    // --- writer1: lands BEFORE local's first rebase attempt (cycle 1 conflict) ---
    const writer1Dir = path.join(root, 'writer1');
    git(['clone', '-q', originDir, writer1Dir], root);
    initRepoUser(writer1Dir);
    writeFileSync(path.join(writer1Dir, 'router.ts'), withIds(['base-1', 'remote-1']));
    git(['add', '-A'], writer1Dir);
    git(['commit', '-q', '-m', 'writer1: append remote-1'], writer1Dir);
    git(['push', '-q', 'origin', 'main'], writer1Dir);

    // local makes its own conflicting append (diverged from its OWN base, not
    // yet aware of writer1's push) — this is the article generator's commit.
    writeFileSync(path.join(localDir, 'router.ts'), withIds(['base-1', 'local-1']));
    git(['add', '-A'], localDir);
    git(['commit', '-q', '-m', 'feat(article): local-1'], localDir);

    // === Cycle 1 (retry-loop iteration N): fetch + rebase -> conflict ===
    git(['fetch', '-q', 'origin', 'main'], localDir);
    expect(() => git(['rebase', 'origin/main'], localDir)).toThrow();
    expect(readFileSync(path.join(localDir, 'router.ts'), 'utf-8')).toMatch(/<<<<<<</);

    const cycle1 = runResolver(localDir, shimDir);
    expect(cycle1.status, `cycle 1 resolver output:\n${cycle1.output}`).toBe(0);
    continueRebase(localDir);

    const afterCycle1 = readFileSync(path.join(localDir, 'router.ts'), 'utf-8');
    expect(afterCycle1).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    expect(afterCycle1.match(/export const ALL_BLOG_ARTICLE_IDS/g)?.length).toBe(1);
    expect(afterCycle1).toContain("'base-1'");
    expect(afterCycle1).toContain("'remote-1'");
    expect(afterCycle1).toContain("'local-1'");

    // --- writer2: lands AFTER cycle 1 resolved locally but BEFORE local's
    // retry push lands — simulating the SAME push needing a SECOND
    // conflicting rebase cycle (loop iteration N+1). writer2 branches off
    // writer1's state (origin only has base+writer1 at this point). ---
    const writer2Dir = path.join(root, 'writer2');
    git(['clone', '-q', originDir, writer2Dir], root);
    initRepoUser(writer2Dir);
    writeFileSync(path.join(writer2Dir, 'router.ts'), withIds(['base-1', 'remote-1', 'remote-2']));
    git(['add', '-A'], writer2Dir);
    git(['commit', '-q', '-m', 'writer2: append remote-2'], writer2Dir);
    git(['push', '-q', 'origin', 'main'], writer2Dir);

    // === Cycle 2 (retry-loop iteration N+1): fetch + rebase -> conflict AGAIN ===
    git(['fetch', '-q', 'origin', 'main'], localDir);
    expect(() => git(['rebase', 'origin/main'], localDir)).toThrow();
    expect(readFileSync(path.join(localDir, 'router.ts'), 'utf-8')).toMatch(/<<<<<<</);

    const cycle2 = runResolver(localDir, shimDir);
    expect(cycle2.status, `cycle 2 resolver output:\n${cycle2.output}`).toBe(0);
    continueRebase(localDir);

    // Push should now succeed (no further concurrent writers).
    git(['push', '-q', 'origin', 'main'], localDir);

    // --- Verify the FINAL state on origin from a fresh checkout ---
    const verifyDir = path.join(root, 'verify');
    git(['clone', '-q', originDir, verifyDir], root);
    const finalContent = readFileSync(path.join(verifyDir, 'router.ts'), 'utf-8');

    // Exactly ONE surviving declaration — the two-cycle conflict history
    // collapsed into a single merged statement, not left as multiple
    // fused/duplicated declarations.
    expect(finalContent.match(/export const ALL_BLOG_ARTICLE_IDS/g)?.length).toBe(1);

    const idMatch = finalContent.match(/ALL_BLOG_ARTICLE_IDS: BlogArticleId\[\] = \[([^\]]*)\];/);
    expect(idMatch).not.toBeNull();
    const ids = [...(idMatch?.[1].matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1]);

    // Every id contributed across BOTH cycles is present, and none is
    // duplicated — the core idempotency claim under test.
    expect(ids.sort()).toEqual(['base-1', 'local-1', 'remote-1', 'remote-2'].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
