/**
 * scripts/ci/background-step.sh — a step moved to the background must fail the
 * job exactly as the foreground step did (deploy.yml prep, thumbnails).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts/ci/background-step.sh');
let dir = '';

function run(...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BACKGROUND_STEP_DIR: dir },
    timeout: 30_000,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'background-step-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('background-step.sh', () => {
  it('joins with the command exit code and prints its log', () => {
    expect(run('start', 'ok', '--', 'bash', '-c', 'echo hello-from-child').status).toBe(0);
    const joined = run('wait', 'ok');
    expect(joined.status).toBe(0);
    expect(joined.stdout).toContain('hello-from-child');
    expect(joined.stdout).toMatch(/finished rc=0 wall_s=\d+/u);
  });

  it('propagates a failure of the background command', () => {
    expect(run('start', 'bad', '--', 'bash', '-c', 'echo boom; exit 7').status).toBe(0);
    const joined = run('wait', 'bad');
    expect(joined.status).toBe(7);
    expect(joined.stdout).toContain('boom');
  });

  it('fails the join for a name that was never started', () => {
    expect(run('wait', 'never').status).toBe(1);
  });

  it('fails the join when the child dies without recording an exit code', () => {
    // The command kills its wrapper shell, so no exit code is ever written.
    expect(run('start', 'killed', '--', 'bash', '-c', 'kill -9 $PPID; sleep 5').status).toBe(0);
    const joined = run('wait', 'killed');
    expect(joined.status).toBe(1);
    expect(joined.stderr).toContain('exited without an exit code');
  });
});
