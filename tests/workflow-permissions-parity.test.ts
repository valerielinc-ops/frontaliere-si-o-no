import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWorkflow,
  compareCallerVsCallee,
  checkRepo,
  // @ts-expect-error — .mjs guardrail script has no .d.ts; runtime ESM import is fine under vitest.
} from '../scripts/check-workflow-permissions-parity.mjs';

// vitest runs with cwd at the repo root; import.meta.url is not a file:// URL
// under the transform, so resolve the CLI path from cwd instead.
const SCRIPT_PATH = join(process.cwd(), 'scripts/check-workflow-permissions-parity.mjs');

/**
 * Guardrail for the #772→#778 class of bug: a caller job invoking a reusable
 * (`workflow_call`) workflow must declare, in its own `permissions:` block,
 * every scope the callee's job(s) request — at an equal-or-stronger level —
 * or the run dies at load time with `startup_failure`.
 *
 * The deterministic checker lives in
 * scripts/check-workflow-permissions-parity.mjs (zero-Claude, pure parsing).
 * These tests cover:
 *   1) the live repo (.github/workflows) has parity (regression gate), and
 *   2) the parser + comparator behave correctly on parity-OK and
 *      parity-violation fixtures.
 */

const REUSABLE = `name: callee
on:
  workflow_call:
jobs:
  do-thing:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write   # github-issue-creator on failure
    steps:
      - run: echo hi
`;

const CALLER_OK = `name: caller-ok
on:
  push:
jobs:
  call-it:
    uses: ./.github/workflows/callee.yml
    secrets: inherit
    permissions:
      contents: read
      issues: write
`;

// Same caller but MISSING issues:write — the exact #772 regression.
const CALLER_VIOLATION = `name: caller-bad
on:
  push:
jobs:
  call-it:
    uses: ./.github/workflows/callee.yml
    secrets: inherit
    permissions:
      contents: read
`;

// Caller grants issues:read where callee needs issues:write — weaker level.
const CALLER_WEAKER = `name: caller-weaker
on:
  push:
jobs:
  call-it:
    uses: ./.github/workflows/callee.yml
    permissions:
      contents: read
      issues: read
`;

describe('check-workflow-permissions-parity — live repo gate', () => {
  it('all caller→callee permission pairs in .github/workflows have parity', () => {
    const { violations, checkedPairs } = checkRepo();
    expect(
      violations,
      `Reusable-workflow caller/callee permission mismatch detected:\n${violations.join('\n')}`,
    ).toEqual([]);
    // There is at least the deploy.yml → post-deploy-* trio; guard the wiring
    // so a refactor that silently stops parsing callers fails loudly.
    expect(checkedPairs, 'expected at least the deploy.yml reusable-workflow callers to be checked').toBeGreaterThanOrEqual(3);
  });
});

describe('check-workflow-permissions-parity — parser', () => {
  it('detects a reusable workflow and unions its job permission requirements', () => {
    const wf = parseWorkflow(REUSABLE);
    expect(wf.isReusable).toBe(true);
    expect(wf.calleePermsByScope).toEqual({ contents: 1, issues: 2 });
  });

  it('extracts caller jobs, callee file, and the caller permissions block', () => {
    const wf = parseWorkflow(CALLER_OK);
    expect(wf.isReusable).toBe(false);
    expect(wf.callers).toHaveLength(1);
    expect(wf.callers[0].calleeFile).toBe('callee.yml');
    expect(wf.callers[0].job).toBe('call-it');
    expect(wf.callers[0].callerPerms).toEqual({ mode: 'map', perms: { contents: 'read', issues: 'write' } });
  });
});

describe('check-workflow-permissions-parity — comparator', () => {
  const callee = parseWorkflow(REUSABLE);

  it('parity-OK fixture yields no violations', () => {
    const caller = parseWorkflow(CALLER_OK).callers[0];
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller-ok → callee.yml');
    expect(v).toEqual([]);
  });

  it('parity-violation fixture (missing issues:write) is flagged', () => {
    const caller = parseWorkflow(CALLER_VIOLATION).callers[0];
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller-bad → callee.yml');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/issues.*write/);
    expect(v[0]).toMatch(/none\/absent/);
  });

  it('weaker-level grant (issues:read where write is needed) is flagged', () => {
    const caller = parseWorkflow(CALLER_WEAKER).callers[0];
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller-weaker → callee.yml');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/grants "issues: read"/);
  });
});

describe('check-workflow-permissions-parity — repo scan over fixtures', () => {
  it('checkRepo flags a violating caller via the injectable fs', () => {
    const files: Record<string, string> = {
      'callee.yml': REUSABLE,
      'caller-bad.yml': CALLER_VIOLATION,
    };
    const { violations, checkedPairs } = checkRepo({
      workflowsDir: '/virtual',
      listDir: () => Object.keys(files),
      readFile: (p: string) => files[p.split('/').pop() as string],
    });
    expect(checkedPairs).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/issues/);
  });

  it('checkRepo passes when caller grants a superset', () => {
    const files: Record<string, string> = {
      'callee.yml': REUSABLE,
      'caller-ok.yml': CALLER_OK,
    };
    const { violations } = checkRepo({
      workflowsDir: '/virtual',
      listDir: () => Object.keys(files),
      readFile: (p: string) => files[p.split('/').pop() as string],
    });
    expect(violations).toEqual([]);
  });
});

// #984 item 1: a reusable callee can request scopes at the *workflow top level*,
// which each job inherits unless it declares its own block. The earlier parser
// only read job-level blocks → a top-level-only callee yielded `{}` and any
// caller passed the gate (false negative on the exact startup_failure class).
const REUSABLE_TOPLEVEL = `name: callee-toplevel
on:
  workflow_call:
permissions:
  contents: read
  issues: write
jobs:
  do-thing:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

// Top-level grants issues:write, but the job declares its OWN block (contents
// only). GitHub job-level permissions fully *replace* the top-level default for
// that job (they do not merge per-scope), so issues:write is NOT effective here.
const REUSABLE_JOB_OVERRIDES_TOPLEVEL = `name: callee-override
on:
  workflow_call:
permissions:
  issues: write
jobs:
  do-thing:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
`;

describe('check-workflow-permissions-parity — top-level callee permissions (#984 item 1)', () => {
  it('reads a callee permissions block declared at the workflow top level', () => {
    const wf = parseWorkflow(REUSABLE_TOPLEVEL);
    expect(wf.isReusable).toBe(true);
    expect(wf.calleePermsByScope).toEqual({ contents: 1, issues: 2 });
  });

  it('a caller missing a top-level-only callee scope is flagged', () => {
    const callee = parseWorkflow(REUSABLE_TOPLEVEL);
    const caller = parseWorkflow(CALLER_VIOLATION).callers[0]; // grants contents only
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller-bad → callee.yml');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/issues.*write/);
  });

  it('a job-level block fully replaces the top-level default (no per-scope merge)', () => {
    const wf = parseWorkflow(REUSABLE_JOB_OVERRIDES_TOPLEVEL);
    expect(wf.calleePermsByScope).toEqual({ contents: 1 });
  });
});

// #984 item 2: job headers are not always indented 2 spaces. The parser must
// auto-detect the indentation or a non-standard caller is silently skipped →
// its permission mismatch goes undetected.
const CALLER_OK_4SPACE = `name: caller-ok-4space
on:
  push:
jobs:
    call-it:
        uses: ./.github/workflows/callee.yml
        permissions:
            contents: read
            issues: write
`;

describe('check-workflow-permissions-parity — non-standard job indentation (#984 item 2)', () => {
  it('discovers a caller whose job header is indented 4 spaces', () => {
    const wf = parseWorkflow(CALLER_OK_4SPACE);
    expect(wf.callers).toHaveLength(1);
    expect(wf.callers[0].calleeFile).toBe('callee.yml');
    expect(wf.callers[0].callerPerms).toEqual({ mode: 'map', perms: { contents: 'read', issues: 'write' } });
  });

  it('checkRepo checks a 4-space-indented caller instead of skipping it', () => {
    const files: Record<string, string> = {
      'callee.yml': REUSABLE,
      'caller-4space.yml': CALLER_OK_4SPACE,
    };
    const { violations, checkedPairs } = checkRepo({
      workflowsDir: '/virtual',
      listDir: () => Object.keys(files),
      readFile: (p: string) => files[p.split('/').pop() as string],
    });
    expect(checkedPairs).toBe(1);
    expect(violations).toEqual([]);
  });
});

// #984 item 4: a callee using a scalar `*-all` is satisfied only by an
// equal-or-stronger scalar `*-all` on the caller. An explicit caller map can
// never cover "all scopes", so it is (correctly) flagged.
const REUSABLE_WRITE_ALL = `name: callee-write-all
on:
  workflow_call:
jobs:
  do-thing:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo hi
`;

const CALLER_WRITE_ALL = `name: caller-write-all
on:
  push:
jobs:
  call-it:
    uses: ./.github/workflows/callee.yml
    permissions: write-all
`;

describe('check-workflow-permissions-parity — scalar *-all callee (#984 item 4)', () => {
  it('parses a job-level scalar write-all as an all-scope requirement', () => {
    const wf = parseWorkflow(REUSABLE_WRITE_ALL);
    expect(wf.calleeScalarAll).toBe(2);
    expect(wf.calleePermsByScope).toEqual({});
  });

  it('caller write-all satisfies callee write-all', () => {
    const callee = parseWorkflow(REUSABLE_WRITE_ALL);
    const caller = parseWorkflow(CALLER_WRITE_ALL).callers[0];
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller → callee.yml');
    expect(v).toEqual([]);
  });

  it('an explicit caller map does NOT satisfy callee write-all (flagged)', () => {
    const callee = parseWorkflow(REUSABLE_WRITE_ALL);
    const caller = parseWorkflow(CALLER_OK).callers[0]; // map: contents+issues
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller → callee.yml');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/write-all/);
  });
});

// #984 item 5: a caller whose permissions are declared only at the workflow top
// level (no job-level block) is treated as granting nothing. This is the safe
// direction — see compareCallerVsCallee's doc comment — and we lock it in.
const CALLER_TOPLEVEL_ONLY = `name: caller-toplevel-only
on:
  push:
permissions:
  contents: read
  issues: write
jobs:
  call-it:
    uses: ./.github/workflows/callee.yml
`;

describe('check-workflow-permissions-parity — caller top-level not used as fallback (#984 item 5)', () => {
  it('a caller job with no own permissions block exposes callerPerms = null', () => {
    const wf = parseWorkflow(CALLER_TOPLEVEL_ONLY);
    expect(wf.callers).toHaveLength(1);
    expect(wf.callers[0].callerPerms).toBeNull();
  });

  it('such a caller is flagged against a callee that needs issues:write', () => {
    const callee = parseWorkflow(REUSABLE);
    const caller = parseWorkflow(CALLER_TOPLEVEL_ONLY).callers[0];
    const v = compareCallerVsCallee(caller.job, caller.callerPerms, callee, 'caller-toplevel → callee.yml');
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((m: string) => /issues.*write/.test(m))).toBe(true);
  });
});

// #984 item 3: the CLI exit-code path is the guardrail's load-bearing contract
// (CI fails the job on exit 1). Drive the real binary against fixture dirs via
// the WORKFLOW_PARITY_DIR override and assert the actual process exit codes —
// not just the in-process checkRepo return — so a silently-swallowed violation
// (e.g. a stray catch) can never make the gate pass while reporting parity.
describe('check-workflow-permissions-parity — CLI exit codes (#984 item 3)', () => {
  function runCli(dir: string): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('node', [SCRIPT_PATH], {
        env: { ...process.env, WORKFLOW_PARITY_DIR: dir },
        encoding: 'utf-8',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'wfparity-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('exits 0 and reports parity OK when callers grant the required scopes', () => {
    const dir = fixtureDir({ 'callee.yml': REUSABLE, 'caller-ok.yml': CALLER_OK });
    try {
      const { status, stdout } = runCli(dir);
      expect(status).toBe(0);
      expect(stdout).toMatch(/parity OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the missing scope when a caller is missing issues:write', () => {
    const dir = fixtureDir({ 'callee.yml': REUSABLE, 'caller-bad.yml': CALLER_VIOLATION });
    try {
      const { status, stderr } = runCli(dir);
      expect(status).toBe(1);
      expect(stderr).toMatch(/issues/);
      expect(stderr).toMatch(/startup_failure/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
