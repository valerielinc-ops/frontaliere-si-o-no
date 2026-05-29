// @vitest-environment node
/**
 * Unit tests for scripts/lint-gha-node-runtime.mjs.
 *
 * The script resolves `.github/workflows` relative to its cwd, so each test
 * spawns it inside a temp dir containing a hand-crafted `.github/workflows`
 * tree — no mocks, real file IO, full exit-code coverage.
 *
 * Covered branches:
 *   - clean repo (all first-party actions on Node ≥ 24) → exit 0
 *   - a first-party action on a deprecated Node runtime (node20) → exit 1
 *   - --min-node override widens what counts as deprecated
 *   - third-party actions never fail the gate (reported as unverifiable)
 *   - --json emits a machine-readable report with the same exit semantics
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/lint-gha-node-runtime.mjs');

function setupWorkflowsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lint-gha-node-'));
  const wf = join(dir, '.github', 'workflows');
  mkdirSync(wf, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(wf, name), content);
  }
  return dir;
}

function run(cwd: string, args: string[] = []) {
  return spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('lint-gha-node-runtime', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('exits 0 when every first-party action is on Node ≥ 24', () => {
    dir = setupWorkflowsDir({
      'ci.yml':
        'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/setup-node@v5\n      - uses: actions/upload-artifact@v7\n',
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 3 first-party action ref\(s\)/);
  });

  it('exits 1 when a first-party action is on a deprecated Node runtime', () => {
    dir = setupWorkflowsDir({
      'deploy.yml':
        'jobs:\n  pages:\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/deploy-pages@v4\n',
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL — 1 first-party action ref/);
    expect(r.stderr).toMatch(/actions\/deploy-pages@v4 → Node 20/);
  });

  it('flags multiple deprecated refs with file:line locations', () => {
    dir = setupWorkflowsDir({
      'a.yml': 'jobs:\n  x:\n    steps:\n      - uses: actions/github-script@v7\n',
      'b.yml': 'jobs:\n  y:\n    steps:\n      - uses: actions/checkout@v4\n',
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL — 2 first-party action ref/);
    expect(r.stderr).toMatch(/a\.yml:\d+ actions\/github-script@v7/);
    expect(r.stderr).toMatch(/b\.yml:\d+ actions\/checkout@v4/);
  });

  it('never fails on third-party actions (runtime not statically knowable)', () => {
    dir = setupWorkflowsDir({
      'ci.yml':
        'jobs:\n  x:\n    steps:\n      - uses: treosh/lighthouse-ci-action@v12\n      - uses: anthropics/claude-code-action@v1\n',
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 third-party ref\(s\) skipped/);
  });

  it('skips local composite action refs', () => {
    dir = setupWorkflowsDir({
      'ci.yml':
        'jobs:\n  x:\n    steps:\n      - uses: ./.github/workflows/reusable.yml\n      - uses: actions/checkout@v5\n',
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 1 first-party action ref/);
  });

  it('--min-node override changes what counts as deprecated', () => {
    dir = setupWorkflowsDir({
      'ci.yml': 'jobs:\n  x:\n    steps:\n      - uses: actions/upload-artifact@v7\n',
    });
    // v7 is Node 24 → fails only when we demand Node ≥ 26
    expect(run(dir, ['--min-node=24']).status).toBe(0);
    expect(run(dir, ['--min-node=26']).status).toBe(1);
  });

  it('--json emits a machine-readable report with matching exit code', () => {
    dir = setupWorkflowsDir({
      'deploy.yml': 'jobs:\n  x:\n    steps:\n      - uses: actions/deploy-pages@v4\n',
    });
    const r = run(dir, ['--json']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.minNode).toBe(24);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].ref).toBe('actions/deploy-pages@v4');
    expect(report.violations[0].node).toBe(20);
  });

  it('reports unknown first-party majors without failing', () => {
    dir = setupWorkflowsDir({
      // v99 is not in the runtime map → unknown, not a violation
      'ci.yml': 'jobs:\n  x:\n    steps:\n      - uses: actions/checkout@v99\n',
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/not in the runtime map/);
  });
});
