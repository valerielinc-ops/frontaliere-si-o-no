import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// The library path already has unit coverage (github-issue-creator-gate.test.ts,
// which mocks node:child_process). This file covers the OTHER entry point: the
// CLI, invoked verbatim by the `else` fallback of post-deploy-validate-dist.yml
// when `scripts/ci/report-validate-dist-failure.mjs` does not exist at the
// build's SHA. That branch reopens the legacy `Validation Failure (dist):
// post-deploy` issue, and until `--build-sha` existed it could not reach the
// guard AT ALL — the exact half-covered shape this repo keeps producing: a
// guard that exists, looks like it covers the case, and is inert on the path
// that actually runs. A mocked module cannot prove a CLI flag is wired, so this
// spawns the real script against a stub `gh` on PATH.
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts/lib/github-issue-creator.mjs');
const TITLE = 'Validation Failure (dist): post-deploy';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A stub `gh` that records every invocation and answers the handful of calls the
 * reopen path makes. Lives in a tmpdir (no package.json above it → CommonJS),
 * and is named `gh` with no extension so PATH lookup finds it.
 */
function makeGhStub({ closedAt, commitDate }: { closedAt: string; commitDate: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  const issue = JSON.stringify([{
    number: 50, title: TITLE, url: 'https://github.com/o/r/issues/50', closedAt, state: 'CLOSED',
  }]);

  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const path = String(args[1] || '');
if (args[0] === 'issue' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1];
  process.stdout.write(state === 'closed' ? ${JSON.stringify(issue)} : '[]');
  process.exit(0);
}
if (args[0] === 'api') {
  if (path.includes('/commits/')) {
    ${commitDate === null
      ? "process.stderr.write('404'); process.exit(1);"
      : `process.stdout.write(${JSON.stringify(commitDate)});`}
    process.exit(0);
  }
  process.stdout.write(''); // /events and /timeline: no closing commit anywhere
  process.exit(0);
}
process.stdout.write('');
`, { mode: 0o755 });
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, log };
}

function runCli(stub: { dir: string; log: string }, extraArgs: string[]) {
  const res = spawnSync(process.execPath, [
    SCRIPT,
    '--title', TITLE,
    '--description', 'dist validation failed',
    '--priority', '1',
    '--reopen-within-hours', '6',
    '--label', 'Bug',
    ...extraArgs,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stub.dir}:${process.env.PATH}`, GH_REPO: 'o/r' },
  });
  const calls: string[][] = existsSync(stub.log)
    ? readFileSync(stub.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { res, calls };
}

const reopened = (calls: string[][]) => calls.some((a) => a[0] === 'issue' && a[1] === 'reopen');
const commentBody = (calls: string[][]) => {
  const c = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
  return c ? String(c[c.indexOf('--body') + 1]) : '';
};

describe('github-issue-creator CLI: --build-sha reaches the reopen guard', () => {
  const CLOSED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const beforeClose = new Date(Date.parse(CLOSED_AT) - 37 * 60 * 1000).toISOString();
  const afterClose = new Date(Date.parse(CLOSED_AT) + 20 * 60 * 1000).toISOString();

  it('build committed BEFORE the close → abstains, and says so on the issue', () => {
    const stub = makeGhStub({ closedAt: CLOSED_AT, commitDate: beforeClose });
    const { res, calls } = runCli(stub, ['--build-sha', '8085cd36']);

    expect(res.status).toBe(0); // best-effort reporter: never adds a second red step
    expect(reopened(calls)).toBe(false);
    expect(commentBody(calls)).toContain('Riapertura saltata');
    expect(commentBody(calls)).toContain('8085cd36');
  });

  it('build committed AFTER the close → real recurrence, reopens', () => {
    const stub = makeGhStub({ closedAt: CLOSED_AT, commitDate: afterClose });
    const { calls } = runCli(stub, ['--build-sha', 'freshsha']);

    expect(reopened(calls)).toBe(true);
    expect(commentBody(calls)).toContain('Reopened');
  });

  it('no --build-sha at all → reopens unconditionally (fail-safe toward reporting)', () => {
    const stub = makeGhStub({ closedAt: CLOSED_AT, commitDate: beforeClose });
    const { calls } = runCli(stub, []);

    expect(reopened(calls)).toBe(true);
    // The guard is not merely inconclusive — it is never consulted, so no
    // commit lookup is attempted on a SHA the caller did not supply.
    expect(calls.some((a) => a[0] === 'api' && String(a[1]).includes('/commits/'))).toBe(false);
  });

  it('--build-sha "" (deploy_ref unset in the workflow) → reopens, never abstains on a missing value', () => {
    const stub = makeGhStub({ closedAt: CLOSED_AT, commitDate: beforeClose });
    const { calls } = runCli(stub, ['--build-sha', '']);

    expect(reopened(calls)).toBe(true);
    expect(calls.some((a) => a[0] === 'api' && String(a[1]).includes('/commits/'))).toBe(false);
  });
});

// The flag is only useful if the caller that needed it actually passes it.
// Asserted on the workflow TEXT because the `else` branch runs a shell string:
// there is no import to follow, and that missing link is exactly why the branch
// went uncovered in the first place.
describe('post-deploy-validate-dist.yml legacy fallback wires --build-sha', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/post-deploy-validate-dist.yml'), 'utf8');

  it('passes the BUILD sha (INPUT_DEPLOY_REF), not the validation run head_sha', () => {
    const fallback = wf.slice(wf.indexOf('fallback al reporter legacy'));
    const invocation = fallback.slice(0, fallback.indexOf('--workflow "Post-deploy Validate Dist"'));
    expect(invocation).toContain('--build-sha "${INPUT_DEPLOY_REF}"');
    expect(invocation).not.toMatch(/--build-sha\s+"?\$\{?GITHUB_SHA/);
  });

  it('INPUT_DEPLOY_REF is bound to inputs.deploy_ref, the build commit', () => {
    expect(wf).toContain('INPUT_DEPLOY_REF: ${{ inputs.deploy_ref }}');
  });
});
