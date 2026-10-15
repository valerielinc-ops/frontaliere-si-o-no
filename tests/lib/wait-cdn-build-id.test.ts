// Tests for scripts/lib/wait-cdn-build-id.sh — the #2569 cross-shard CDN-push
// ordering guard. The non-IT matrix shards run this before publishing so they
// never go live ahead of the IT CDN push.
//
// We never hit the real CDN: a tiny local file: URL stands in for the marker
// endpoint (curl supports file://), so the match / no-op / timeout branches are
// all covered deterministically and fast.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPT = resolve('scripts/lib/wait-cdn-build-id.sh');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function markerUrl(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-build-id-'));
  const file = join(dir, 'cdn-build-id.txt');
  writeFileSync(file, contents);
  return `file://${file}`;
}

describe('scripts/lib/wait-cdn-build-id.sh', () => {
  it('is a no-op (exit 0) when no expected build id is given (non-matrix / local path)', () => {
    const { code, stdout } = run([''], { CDN_WAIT_TIMEOUT_S: '0' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/no expected build id/i);
  });

  it('unblocks (exit 0) when the CDN marker already equals the expected id', () => {
    const url = markerUrl('1718000000123');
    const { code, stdout } = run(['1718000000123'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '5',
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/CDN published build id=1718000000123/);
  });

  it('tolerates trailing whitespace/newline in the marker', () => {
    const url = markerUrl('1718000000123\n');
    const { code } = run(['1718000000123'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '5',
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(code).toBe(0);
  });

  it('fails (exit 1) when the CDN never reaches the expected id within the timeout', () => {
    const url = markerUrl('an-older-build-id');
    const { code, stdout } = run(['the-new-build-id'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '0', // immediate single-shot poll then give up
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(code).toBe(1);
    expect(stdout).toMatch(/timed out/i);
    expect(stdout).toMatch(/#2569/);
  });

  it('fails (exit 1) when the marker endpoint is missing (404) and the timeout elapses', () => {
    const url = `file://${join(tmpdir(), 'does-not-exist-cdn-build-id.txt')}`;
    const { code, stdout } = run(['some-build-id'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '0',
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(code).toBe(1);
    expect(stdout).toMatch(/timed out/i);
  });

  it('fails closed before marker polling when #7049 readiness is armed but the jobs API is unobservable', () => {
    const { code, stdout } = run(['the-new-build-id'], {
      // Even an already-matching marker cannot bypass a readiness phase whose
      // authenticated source is missing: production wires all prerequisites.
      CDN_BUILD_ID_URL: markerUrl('the-new-build-id'),
      CDN_IT_JOB_NAME: 'build-locale (it)',
      CDN_IT_READY_STEP_NAME: 'Push generated assets to CDN (early — ahead of the shard pushes)',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    });
    expect(code).toBe(1);
    expect(stdout).toMatch(/readiness gate unobservable/i);
    expect(stdout).toMatch(/marker polling was NOT started/i);
    expect(stdout).not.toMatch(/CDN published build id/);
  });
});
