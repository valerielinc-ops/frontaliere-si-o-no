// Tests for scripts/lib/trigger-self.sh — best-effort self-dispatch helper.
// We exercise the SKIP path (no token) and the misconfiguration path
// (no WORKFLOW_FILE). We never hit the real GitHub API: success requires
// a real PAT + WORKFLOW_FILE, so the curl branch is intentionally not
// covered here.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = resolve('scripts/lib/trigger-self.sh');

function run(env = {}, opts = {}) {
  // Use a per-call GITHUB_OUTPUT file so we can assert the key=value writes
  const tmp = mkdtempSync(join(tmpdir(), 'trigger-self-'));
  const outFile = join(tmp, 'output');
  // Touch the file (the script appends, doesn't create)
  execFileSync('bash', ['-c', `: > "${outFile}"`]);
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: outFile,
        ...env,
      },
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    const githubOutput = readFileSync(outFile, 'utf8');
    return { code: 0, stdout, stderr: '', githubOutput };
  } catch (e) {
    const githubOutput = (() => {
      try {
        return readFileSync(outFile, 'utf8');
      } catch {
        return '';
      }
    })();
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      githubOutput,
    };
  }
}

describe('scripts/lib/trigger-self.sh', () => {
  it('skips silently when no GITHUB_PAT and no GH_TOKEN are set', () => {
    const { code, stdout, githubOutput } = run({
      WORKFLOW_FILE: 'generate-article.yml',
    });
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/skip/);
    expect(githubOutput).toMatch(/dispatch_sent=false/);
  });

  it('exits 1 with a clear error when WORKFLOW_FILE is missing', () => {
    const { code, stdout, stderr, githubOutput } = run({
      GITHUB_PAT: 'fake-token',
    });
    expect(code).toBe(1);
    expect(stdout + stderr).toMatch(/WORKFLOW_FILE/);
    expect(githubOutput).toMatch(/dispatch_sent=false/);
  });

  it('respects DELAY_SECONDS=0 (no observable sleep on the fast path)', () => {
    const start = Date.now();
    run({
      WORKFLOW_FILE: 'generate-article.yml',
      DELAY_SECONDS: '0',
    });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('writes self_trigger_reason to GITHUB_OUTPUT for observability', () => {
    const { githubOutput } = run({
      WORKFLOW_FILE: 'generate-article.yml',
      SELF_TRIGGER_REASON: 'no_changes',
    });
    expect(githubOutput).toMatch(/self_trigger_reason=no_changes/);
  });
});
