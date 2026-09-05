/**
 * Two workflow-hygiene invariants that both fail SILENTLY in production, which is
 * exactly why they need a test rather than a code review habit.
 *
 * 1. `npx tsx` without `--no-install` in a workflow that already ran `npm ci`
 *    (issue #7390). If the local resolution fails — cache not restored, partial
 *    `npm ci`, install step skipped by an `if:` — npx silently downloads tsx from
 *    the registry and the job keeps going on a version nobody pinned, or dies with
 *    a network error that looks nothing like the real cause (a missing local
 *    dependency). With `--no-install` the absence is an immediate, legible failure.
 *
 *    The three workflows that deliberately run WITHOUT `npm ci` and rely on the
 *    download (`npx -y tsx@4` style) are exempt by construction: they have no
 *    `npm ci` step, so the predicate below never looks at them. No allowlist is
 *    needed — "has an npm ci step" IS the discriminator.
 *
 * 2. `--regenerate-cmd` resolving files from a reflog position (`HEAD@{N}`)
 *    instead of a pinned SHA (issue #7389). scripts/lib/git-push-with-retry.sh
 *    runs the regenerate command AFTER `git rebase --abort` + `git reset --hard`,
 *    both of which append reflog entries, so `HEAD@{1}` is not a stable handle on
 *    the commit the caller just made. Combined with a `2>/dev/null || true` tail
 *    it pushed stale content and lost the registration without an error.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = join(__dirname, '..', '.github', 'workflows');

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({ name: f, body: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }));

/** A real `npm ci` run step, not the word inside a comment saying "deliberately NO npm ci". */
const runsNpmCi = (body: string) =>
  body.split('\n').some((line) => /^\s*(-\s*)?(run:\s*)?npm ci\b/.test(line) && !/^\s*#/.test(line));

describe('workflow hygiene: npx tsx (#7390)', () => {
  it('finds at least one workflow that runs npm ci (guards against a vacuous pass)', () => {
    expect(workflows.filter((w) => runsNpmCi(w.body)).length).toBeGreaterThan(0);
  });

  it('never invokes bare `npx tsx` in a workflow that already ran npm ci', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows) {
      if (!runsNpmCi(body)) continue;
      body.split('\n').forEach((line, i) => {
        // Bare `npx tsx`: any npx invocation of tsx with no flag between the two.
        if (/\bnpx\s+tsx\b/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('workflow hygiene: --regenerate-cmd (#7389)', () => {
  it('never resolves a regenerate-cmd from a reflog position', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows) {
      body.split('\n').forEach((line, i) => {
        if (/HEAD@\{\d+\}/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('never masks a regenerate-cmd checkout failure with `|| true`', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows) {
      body.split('\n').forEach((line, i) => {
        if (/--regenerate-cmd/.test(line) && /git checkout .*\|\|\s*true/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
