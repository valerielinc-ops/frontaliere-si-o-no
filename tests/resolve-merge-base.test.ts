/**
 * resolve-merge-base.mjs coverage (issue #5195).
 *
 * The original suite for this module asserted only `formatUnresolvableMerge
 * BaseMessage` (pure) and `resolveMergeBase('HEAD')` — HEAD always has a
 * merge-base with itself, so it exercised the happy path exclusively. The
 * whole point of #5195 is the path where the base CANNOT be resolved, and
 * that path was untested: nothing here would have gone red if the bail-out
 * had silently reverted to `exit 0` with an empty candidate list.
 *
 * So the unresolvable path is now covered end-to-end against real git, using
 * a throwaway repo with two genuinely unrelated histories (orphan branch).
 * That repo is NOT shallow, so `resolveMergeBase` returns null immediately —
 * no `git fetch --deepen`, no network, hermetic and fast.
 *
 * The load-bearing assertions are the negative ones: an un-run analysis must
 * never be reported as a clean one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveMergeBase,
  formatUnresolvableMergeBaseMessage,
  formatUnresolvableMergeBaseVerdict,
  unresolvedBaseOverrideActive,
  ALLOW_UNRESOLVED_ENV,
} from '../scripts/ci/lib/resolve-merge-base.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING_SCRIPT = path.join(REPO_ROOT, 'scripts/ci/check-sibling-patterns.mjs');
const BRIDGE_SCRIPT = path.join(REPO_ROOT, 'scripts/ci/check-below-floor-bridge.mjs');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts/ci/sibling-check-gate.mjs');

/**
 * Run a command, capturing status + BOTH streams. `spawnSync`, not
 * `execFileSync`: the latter returns stdout only and surfaces stderr just on
 * the throwing path, which would silently blank out every stderr assertion on
 * the exit-0 (override) cases — the same "absence read as success" mistake
 * this suite exists to catch.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input ?? '',
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Throwaway repo whose `origin/main` points at an orphan branch: no common
 * ancestor with HEAD exists, so `git merge-base` comes back empty exactly as
 * it does on the reporting machine's shallow clone — without needing to
 * fabricate a shallow boundary or hit the network.
 */
let tmpRepo: string;

beforeAll(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-base-test-'));
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: tmpRepo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.mkdirSync(path.join(tmpRepo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'scripts/update-thing.mjs'), 'export const A_FLOOR = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'first');
  g('checkout', '-q', '--orphan', 'unrelated');
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'unrelated history\n');
  g('add', '-A');
  g('commit', '-qm', 'orphan');
  g('checkout', '-q', 'main');
  const orphan = execFileSync('git', ['rev-parse', 'unrelated'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
  g('update-ref', 'refs/remotes/origin/main', orphan);
});

afterAll(() => {
  if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe('formatUnresolvableMergeBaseMessage', () => {
  it('mentions the shallow clone without deepening when deepened=false', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', false);
    expect(msg).toContain('su clone shallow');
    expect(msg).not.toContain('anche dopo aver approfondito');
  });

  it('mentions the deepen attempt when deepened=true', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', true);
    expect(msg).toContain('anche dopo aver approfondito il clone shallow');
  });

  it('includes the base ref for debuggability', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', false);
    expect(msg).toContain('origin/main');
  });

  // CI checks out with `fetch-depth: 0`. Blaming a shallow clone there sends
  // the reader after a disk-space problem that does not exist, while the real
  // cause (missing/wrong base ref, unrelated histories) goes unmentioned.
  it('does NOT blame the shallow clone on a non-shallow checkout', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', false, false);
    expect(msg).not.toContain('su clone shallow');
    expect(msg).toContain('NON shallow');
  });

  it('surfaces a failed deepen fetch distinctly from an exhausted one', () => {
    const failed = formatUnresolvableMergeBaseMessage('origin/main', true, true, true);
    expect(failed).toContain('è FALLITO');
    const exhausted = formatUnresolvableMergeBaseMessage('origin/main', true, true, false);
    expect(exhausted).not.toContain('è FALLITO');
  });
});

describe('unresolvedBaseOverrideActive', () => {
  it('is off by default — the skip blocks unless deliberately overridden', () => {
    expect(unresolvedBaseOverrideActive({})).toBe(false);
    expect(unresolvedBaseOverrideActive({ [ALLOW_UNRESOLVED_ENV]: '0' })).toBe(false);
  });

  it('accepts 1 and true', () => {
    expect(unresolvedBaseOverrideActive({ [ALLOW_UNRESOLVED_ENV]: '1' })).toBe(true);
    expect(unresolvedBaseOverrideActive({ [ALLOW_UNRESOLVED_ENV]: 'true' })).toBe(true);
  });
});

describe('formatUnresolvableMergeBaseVerdict', () => {
  const resolution = { mergeBase: null, deepened: true, shallow: true, fetchFailed: false };

  it('blocks by default and never reads as an all-clear', () => {
    const v = formatUnresolvableMergeBaseVerdict('check-sibling-patterns', 'origin/main', resolution, {});
    expect(v.blocking).toBe(true);
    expect(v.overridden).toBe(false);
    expect(v.banner).toContain('ANALISI NON ESEGUITA');
    expect(v.banner).toContain('NON è un via libera');
    expect(v.banner).toContain(ALLOW_UNRESOLVED_ENV);
  });

  it('stops blocking under the explicit override but stays loud about it', () => {
    const v = formatUnresolvableMergeBaseVerdict('check-sibling-patterns', 'origin/main', resolution, {
      [ALLOW_UNRESOLVED_ENV]: '1',
    });
    expect(v.blocking).toBe(false);
    expect(v.overridden).toBe(true);
    expect(v.banner).toContain('ANALISI NON ESEGUITA');
    expect(v.banner).toContain('NESSUN sibling è stato verificato');
  });
});

describe('resolveMergeBase (real git)', () => {
  it('resolves HEAD vs HEAD without needing to deepen', () => {
    const { mergeBase, deepened } = resolveMergeBase('HEAD');
    expect(mergeBase).toBeTruthy();
    expect(deepened).toBe(false);
  });

  // resolveMergeBase reads the repo at process.cwd(), and `process.chdir` does
  // not exist in vitest's worker threads — so this runs in a child process
  // whose cwd is the throwaway repo.
  it('returns null — never a bogus fallback — when histories are unrelated', () => {
    const modUrl = JSON.stringify(
      new URL('../scripts/ci/lib/resolve-merge-base.mjs', import.meta.url).href,
    );
    const r = run(
      'node',
      [
        '--input-type=module',
        '-e',
        `const { resolveMergeBase } = await import(${modUrl});` +
          'process.stdout.write(JSON.stringify(resolveMergeBase("origin/main")));',
      ],
      { cwd: tmpRepo },
    );
    expect(r.status).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.mergeBase).toBeNull();
    // Non-shallow ⇒ no fetch attempted: deepening cannot relate two genuinely
    // unrelated histories, and the reporting machine has ~5GB of disk headroom
    // to lose to a pointless deepen.
    expect(res.shallow).toBe(false);
    expect(res.deepened).toBe(false);
    expect(res.fetchFailed).toBe(false);
  });
});

// ── The regression tests that matter: a skipped analysis must not pass ──────
describe('unresolvable base is a blocking skip, not a silent pass', () => {
  it('check-sibling-patterns --json marks the report skipped and warns on stderr', () => {
    const r = run('node', [SIBLING_SCRIPT, '--json'], { cwd: tmpRepo });
    const report = JSON.parse(r.stdout);
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe('unresolvable-merge-base');
    expect(report.candidates).toEqual([]);
    // stdout is the JSON contract, so the human-facing warning has to go to
    // stderr or it is lost entirely for every caller that pipes stdout.
    expect(r.stderr).toContain('ANALISI NON ESEGUITA');
  });

  it('check-sibling-patterns --strict EXITS 1 on an unresolvable base', () => {
    const r = run('node', [SIBLING_SCRIPT, '--strict'], { cwd: tmpRepo });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ANALISI NON ESEGUITA');
  });

  it('check-sibling-patterns --strict exits 0 only under the explicit override', () => {
    const r = run('node', [SIBLING_SCRIPT, '--strict'], {
      cwd: tmpRepo,
      env: { [ALLOW_UNRESOLVED_ENV]: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NESSUN sibling è stato verificato');
  });

  it('check-below-floor-bridge (the sibling script) behaves identically', () => {
    const j = run('node', [BRIDGE_SCRIPT, '--json'], { cwd: tmpRepo });
    const report = JSON.parse(j.stdout);
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe('unresolvable-merge-base');
    // The workflow parser reads `gapsByFile.length` unconditionally under
    // `set -euo pipefail` (PR #3749) — the key must survive the skip branch.
    expect(report.gapsByFile).toEqual([]);
    expect(j.stderr).toContain('ANALISI NON ESEGUITA');

    const s = run('node', [BRIDGE_SCRIPT, '--strict'], { cwd: tmpRepo });
    expect(s.status).toBe(1);
  });

  it('sibling-check-gate BLOCKS gh pr create instead of passing silently', () => {
    const payload = JSON.stringify({
      tool_input: { command: 'gh pr create --title t --body "## Implementato\nx\n"' },
    });
    const r = run('node', [GATE_SCRIPT], { cwd: tmpRepo, input: payload });
    // EXIT_BLOCK (2), not 1: a PreToolUse hook that exits 1 is a NON-blocking
    // error and `gh pr create` runs anyway — the gate would print its refusal
    // and be ignored.
    expect(r.status).toBe(EXIT_BLOCK);
    expect(EXIT_BLOCK).toBe(2);
    expect(r.stderr).toContain('sweep sibling NON ESEGUITO');
    expect(r.stderr).toContain('NON equivale a "nessun candidato"');
  });

  it('sibling-check-gate allows the PR under the explicit override', () => {
    const payload = JSON.stringify({
      tool_input: { command: 'gh pr create --title t --body "## Implementato\nx\n"' },
    });
    const r = run('node', [GATE_SCRIPT], {
      cwd: tmpRepo,
      input: payload,
      env: { [ALLOW_UNRESOLVED_ENV]: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('scelta dichiarata');
  });
});
