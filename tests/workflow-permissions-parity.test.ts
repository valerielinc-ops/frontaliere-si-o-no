import { describe, it, expect } from 'vitest';
import {
  parseWorkflow,
  compareCallerVsCallee,
  checkRepo,
  // @ts-expect-error — .mjs guardrail script has no .d.ts; runtime ESM import is fine under vitest.
} from '../scripts/check-workflow-permissions-parity.mjs';

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
